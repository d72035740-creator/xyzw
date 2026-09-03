import { and, desc, eq } from "drizzle-orm";
import { db, type Database } from "@/db/client";
import { agentRuns, missionEvents, missionItems, missions } from "@/db/schema";
import { MissionError } from "@/domain/errors";
import { assertTransition } from "@/domain/mission-state";
import type { MerchantAdapter, MerchantReservation } from "@/commerce/merchant-adapter";
import { MerchantError } from "@/commerce/merchant-errors";
import type { MissionAuthority } from "@/services/mission-authority";
import { PlannerError } from "./planner-errors";
import { MissionPlanValidator } from "./mission-plan-validator";
import {
  missionPlanProposalSchema,
  type MissionPlanner,
  type MissionPlanningInput,
  type PlannerOfferInput,
} from "./planner-types";

type AgentRunStatus = typeof agentRuns.$inferSelect.status;

function safeErrorCode(error: unknown): string {
  if (
    error instanceof PlannerError ||
    error instanceof MissionError ||
    error instanceof MerchantError
  ) {
    return error.code;
  }
  return "PLAN_EXECUTION_FAILED";
}

function rejectedStatus(error: unknown): AgentRunStatus {
  return error instanceof PlannerError || error instanceof MissionError || error instanceof MerchantError
    ? "REJECTED"
    : "FAILED";
}

export interface MissionPlanExecutionResult {
  agentRunId: string;
  missionId: string;
  missionVersion: number;
  status: "READY_TO_COMMIT";
  actualTotalAmount: number;
  remainingAmount: number;
  reservations: MerchantReservation[];
}

export class MissionPlanningService {
  constructor(
    private readonly planner: MissionPlanner,
    private readonly merchantAdapter: MerchantAdapter,
    private readonly authority: MissionAuthority,
    private readonly database: Database = db,
    private readonly validator = new MissionPlanValidator(),
  ) {}

  async plan(input: {
    missionId: string;
    expectedVersion: number;
    requestKey?: string;
  }): Promise<MissionPlanExecutionResult> {
    const started = await this.startRun(input);
    let proposal: unknown = null;
    let currentVersion = started.missionVersion;
    let acceptedForReservation = false;
    const createdReservations: MerchantReservation[] = [];
    try {
      const planningInput = await this.buildPlanningInput(input.missionId, currentVersion);
      await this.database
        .update(agentRuns)
        .set({ inputSnapshot: planningInput as unknown as Record<string, unknown> })
        .where(eq(agentRuns.id, started.agentRunId));

      proposal = await this.planner.createPlan(planningInput);
      const structured = missionPlanProposalSchema.safeParse(proposal);
      if (!structured.success) {
        throw new PlannerError("INVALID_AI_RESPONSE", "Planner output failed strict schema validation");
      }

      const validationContext = await this.loadValidationContext(input.missionId);
      const currentOffers = await this.merchantAdapter.searchOffers({ availableOnly: false });
      const validated = this.validator.validate(
        validationContext,
        structured.data,
        currentOffers.map(this.toPlannerOffer),
      );
      currentVersion = await this.acceptProposal(started.agentRunId, validated.actualTotalAmount, structured.data);
      acceptedForReservation = true;

      for (const offer of validated.offers) {
        const reservation = await this.merchantAdapter.reserveOffer({
          missionId: input.missionId,
          offerId: offer.id,
          expectedMissionVersion: currentVersion,
          expectedOfferVersion: offer.version,
        });
        createdReservations.push(reservation);
        currentVersion += 1;
      }

      const finalValidation = await this.authority.validateMission(input.missionId, currentVersion);
      currentVersion = finalValidation.missionVersion;
      if (!finalValidation.valid || finalValidation.status !== "READY_TO_COMMIT") {
        throw new PlannerError("PLAN_EXECUTION_FAILED", "Reserved plan failed final validation", 409, {
          violations: finalValidation.violations,
        });
      }
      await this.completeRun(started.agentRunId, input.missionId, currentVersion);
      const remainingAmount = await this.authority.remaining(input.missionId);
      return {
        agentRunId: started.agentRunId,
        missionId: input.missionId,
        missionVersion: currentVersion,
        status: "READY_TO_COMMIT",
        actualTotalAmount: validated.actualTotalAmount,
        remainingAmount,
        reservations: createdReservations,
      };
    } catch (error) {
      let compensationError: unknown;
      for (const reservation of [...createdReservations].reverse()) {
        try {
          await this.merchantAdapter.releaseOffer({
            reservationId: reservation.id,
            expectedMissionVersion: currentVersion,
          });
          currentVersion += 1;
        } catch (caught) {
          compensationError = caught;
          break;
        }
      }
      if (acceptedForReservation) {
        currentVersion = await this.invalidateFailedExecution(
          input.missionId,
          currentVersion,
          createdReservations.map((item) => item.id),
        );
      }
      await this.rejectRun(
        started.agentRunId,
        input.missionId,
        currentVersion,
        compensationError ?? error,
        proposal,
      );
      if (compensationError) {
        throw new PlannerError(
          "PLAN_EXECUTION_FAILED",
          "Planning failed and reservation compensation was incomplete",
          500,
        );
      }
      throw error;
    }
  }

  async getLatestRun(missionId: string) {
    const [run] = await this.database
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.missionId, missionId))
      .orderBy(desc(agentRuns.startedAt))
      .limit(1);
    return run ?? null;
  }

  private async startRun(input: { missionId: string; expectedVersion: number; requestKey?: string }) {
    return this.database.transaction(async (transaction) => {
      const [mission] = await transaction
        .select()
        .from(missions)
        .where(eq(missions.id, input.missionId))
        .for("update");
      if (!mission) throw new MissionError("MISSION_NOT_FOUND", "Mission not found", 404);
      if (mission.version !== input.expectedVersion) {
        throw new MissionError("STALE_PLAN", "Mission version does not match", 409, {
          expectedVersion: input.expectedVersion,
          currentVersion: mission.version,
        });
      }
      if (input.requestKey) {
        const [existing] = await transaction
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(
            and(eq(agentRuns.missionId, mission.id), eq(agentRuns.requestKey, input.requestKey)),
          );
        if (existing) {
          throw new PlannerError("DUPLICATE_PLAN_REQUEST", "Planning request was already accepted", 409);
        }
      }
      if (mission.status !== "DRAFT" && mission.status !== "PLANNING") {
        throw new PlannerError(
          "PLAN_INVALID_STATE",
          `Cannot start planning while mission is ${mission.status}`,
          409,
        );
      }
      let missionVersion = mission.version;
      if (mission.status === "DRAFT") {
        assertTransition("DRAFT", "PLANNING");
        missionVersion += 1;
        await transaction
          .update(missions)
          .set({ status: "PLANNING", version: missionVersion, updatedAt: new Date() })
          .where(eq(missions.id, mission.id));
      }
      const [run] = await transaction
        .insert(agentRuns)
        .values({
          missionId: mission.id,
          missionVersion,
          requestKey: input.requestKey,
          plannerId: this.planner.plannerId,
          modelId: this.planner.modelId,
          inputSnapshot: { missionId: mission.id, missionVersion },
        })
        .returning({ id: agentRuns.id });
      await transaction.insert(missionEvents).values({
        missionId: mission.id,
        type: "MISSION_PLANNING_STARTED",
        missionVersion,
        data: { agentRunId: run.id, plannerId: this.planner.plannerId },
      });
      return { agentRunId: run.id, missionVersion };
    });
  }

  private async buildPlanningInput(missionId: string, expectedVersion: number): Promise<MissionPlanningInput> {
    const mission = await this.loadValidationContext(missionId);
    if (mission.version !== expectedVersion) throw new MissionError("STALE_PLAN", "Mission changed during planning", 409);
    const [row] = await this.database.select().from(missions).where(eq(missions.id, missionId));
    const offers = await this.merchantAdapter.searchOffers({ availableOnly: false });
    return {
      mission: {
        id: mission.id,
        version: mission.version,
        goal: row.goal,
        budgetAmount: mission.budgetAmount,
        deadline: mission.deadline.toISOString(),
        requiredCategories: mission.requiredCategories,
        constraints: mission.constraints,
      },
      offers: offers.map(this.toPlannerOffer),
    };
  }

  private readonly toPlannerOffer = (offer: Awaited<ReturnType<MerchantAdapter["searchOffers"]>>[number]): PlannerOfferInput => ({
    id: offer.id,
    code: offer.code,
    category: offer.category,
    name: offer.name,
    description: offer.description,
    amount: offer.amount,
    available: offer.available,
    readyAt: offer.readyAt.toISOString(),
    version: offer.version,
    vegetarian: offer.vegetarian,
    servesPeople: offer.servesPeople,
  });

  private async loadValidationContext(missionId: string) {
    const [mission, items] = await Promise.all([
      this.database.select().from(missions).where(eq(missions.id, missionId)).then((rows) => rows[0]),
      this.database.select().from(missionItems).where(eq(missionItems.missionId, missionId)),
    ]);
    if (!mission) throw new MissionError("MISSION_NOT_FOUND", "Mission not found", 404);
    return {
      id: mission.id,
      version: mission.version,
      status: mission.status,
      budgetAmount: mission.budgetAmount,
      deadline: mission.deadline,
      requiredCategories: items.filter((item) => item.required).map((item) => item.category),
      constraints: mission.constraints,
    };
  }

  private async acceptProposal(
    agentRunId: string,
    actualTotalAmount: number,
    proposal: ReturnType<typeof missionPlanProposalSchema.parse>,
  ): Promise<number> {
    return this.database.transaction(async (transaction) => {
      const [mission] = await transaction
        .select()
        .from(missions)
        .where(eq(missions.id, proposal.missionId))
        .for("update");
      if (!mission) throw new MissionError("MISSION_NOT_FOUND", "Mission not found", 404);
      if (mission.version !== proposal.missionVersion) {
        throw new MissionError("STALE_PLAN", "Mission changed after AI planning", 409);
      }
      if (mission.status !== "PLANNING") {
        throw new PlannerError("PLAN_INVALID_STATE", "Mission left PLANNING before execution", 409);
      }
      assertTransition("PLANNING", "PROPOSED");
      const proposedVersion = mission.version + 1;
      await transaction
        .update(missions)
        .set({ status: "PROPOSED", version: proposedVersion, updatedAt: new Date() })
        .where(eq(missions.id, mission.id));
      await transaction.insert(missionEvents).values({
        missionId: mission.id,
        type: "AI_PLAN_PROPOSED",
        missionVersion: proposedVersion,
        data: {
          agentRunId,
          offerIds: proposal.selectedOffers.map((item) => item.offerId),
          actualTotalAmount,
          aiReportedTotalAmount: proposal.totalAmount,
        },
      });
      assertTransition("PROPOSED", "RESERVING");
      const reservingVersion = proposedVersion + 1;
      await transaction
        .update(missions)
        .set({ status: "RESERVING", version: reservingVersion, updatedAt: new Date() })
        .where(eq(missions.id, mission.id));
      await transaction.insert(missionEvents).values({
        missionId: mission.id,
        type: "MISSION_RESERVING",
        missionVersion: reservingVersion,
        data: { agentRunId },
      });
      await transaction
        .update(agentRuns)
        .set({
          rawOutput: proposal as unknown as Record<string, unknown>,
          validatedProposal: {
            ...proposal,
            actualTotalAmount,
          } as unknown as Record<string, unknown>,
        })
        .where(eq(agentRuns.id, agentRunId));
      return reservingVersion;
    });
  }

  private async invalidateFailedExecution(
    missionId: string,
    expectedVersion: number,
    reservationIds: string[],
  ): Promise<number> {
    return this.database.transaction(async (transaction) => {
      const [mission] = await transaction
        .select()
        .from(missions)
        .where(eq(missions.id, missionId))
        .for("update");
      if (!mission) throw new MissionError("MISSION_NOT_FOUND", "Mission not found", 404);
      if (mission.version !== expectedVersion) throw new MissionError("STALE_PLAN", "Mission changed during compensation", 409);
      if (mission.status === "INVALIDATED") {
        if (reservationIds.length > 0) {
          await transaction.insert(missionEvents).values({
            missionId,
            type: "PLAN_RESERVATION_COMPENSATED",
            missionVersion: mission.version,
            data: { reservationIds },
          });
        }
        return mission.version;
      }
      assertTransition(mission.status, "INVALIDATED");
      const nextVersion = mission.version + 1;
      await transaction
        .update(missions)
        .set({ status: "INVALIDATED", version: nextVersion, updatedAt: new Date() })
        .where(eq(missions.id, missionId));
      if (reservationIds.length > 0) {
        await transaction.insert(missionEvents).values({
          missionId,
          type: "PLAN_RESERVATION_COMPENSATED",
          missionVersion: nextVersion,
          data: { reservationIds },
        });
      }
      return nextVersion;
    });
  }

  private async rejectRun(
    agentRunId: string,
    missionId: string,
    missionVersion: number,
    error: unknown,
    proposal: unknown,
  ) {
    const status = rejectedStatus(error);
    const errorCode = safeErrorCode(error);
    await this.database.transaction(async (transaction) => {
      await transaction
        .update(agentRuns)
        .set({
          status,
          errorCode,
          rawOutput:
            proposal && typeof proposal === "object"
              ? (proposal as Record<string, unknown>)
              : undefined,
          completedAt: new Date(),
        })
        .where(eq(agentRuns.id, agentRunId));
      await transaction.insert(missionEvents).values({
        missionId,
        type: "AI_PLAN_REJECTED",
        missionVersion,
        data: { agentRunId, errorCode },
      });
    });
  }

  private async completeRun(agentRunId: string, missionId: string, missionVersion: number) {
    await this.database.transaction(async (transaction) => {
      await transaction
        .update(agentRuns)
        .set({ status: "SUCCEEDED", completedAt: new Date() })
        .where(eq(agentRuns.id, agentRunId));
      await transaction.insert(missionEvents).values({
        missionId,
        type: "MISSION_READY_TO_COMMIT",
        missionVersion,
        data: { agentRunId },
      });
    });
  }
}
