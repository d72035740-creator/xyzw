import { and, desc, eq } from "drizzle-orm";
import type { MerchantAdapter, MerchantOffer, MerchantReservation } from "@/commerce/merchant-adapter";
import { MerchantError } from "@/commerce/merchant-errors";
import { reservationTermsAreStale } from "@/commerce/merchant-world";
import { db, type Database } from "@/db/client";
import {
  missionEvents,
  missionItems,
  missionRepairAttempts,
  missions,
} from "@/db/schema";
import { MissionError } from "@/domain/errors";
import { assertTransition } from "@/domain/mission-state";
import type { MissionAuthority } from "@/services/mission-authority";
import { RepairError } from "./repair-errors";
import { MissionRepairValidator } from "./mission-repair-validator";
import { enumerateRepairOptions } from "./repair-ranking";
import {
  missionRepairProposalSchema,
  type MissionRepairInput,
  type MissionRepairPlanner,
  type RepairContext,
  type ValidatedRepair,
} from "./repair-types";

function errorCode(error: unknown): string {
  if (error instanceof RepairError || error instanceof MissionError || error instanceof MerchantError) {
    return error.code;
  }
  return "REPAIR_RESERVATION_FAILED";
}

function isExpectedError(error: unknown): boolean {
  return error instanceof RepairError || error instanceof MissionError || error instanceof MerchantError;
}

export interface MissionRepairResult {
  repairAttemptId: string;
  missionId: string;
  previousVersion: number;
  missionVersion: number;
  status: "READY_TO_COMMIT";
  preservedReservationIds: string[];
  releasedReservationIds: string[];
  replacementReservationIds: string[];
  changedItemCount: number;
  previousReservedAmount: number;
  newReservedAmount: number;
  remainingAmount: number;
  committedAmount: number;
}

export class MissionRepairService {
  constructor(
    private readonly planner: MissionRepairPlanner,
    private readonly merchantAdapter: MerchantAdapter,
    private readonly authority: MissionAuthority,
    private readonly database: Database = db,
    private readonly validator = new MissionRepairValidator(),
  ) {}

  async repair(input: {
    missionId: string;
    expectedVersion: number;
    requestKey?: string;
  }): Promise<MissionRepairResult> {
    const started = await this.startAttempt(input);
    let currentVersion = started.replanningVersion;
    let proposal: unknown = null;
    let validated: ValidatedRepair | null = null;
    const releasedReservationIds: string[] = [];
    const replacementReservations: MerchantReservation[] = [];
    try {
      let context = await this.buildContext(input.missionId, currentVersion);
      const repairInput = this.toRepairInput(context);
      await this.database
        .update(missionRepairAttempts)
        .set({ inputSnapshot: repairInput as unknown as Record<string, unknown> })
        .where(eq(missionRepairAttempts.id, started.repairAttemptId));

      proposal = await this.planner.createRepair(repairInput);
      const parsed = missionRepairProposalSchema.safeParse(proposal);
      if (!parsed.success) {
        throw new RepairError("INVALID_REPAIR_PROPOSAL", "Repair planner output failed strict schema validation");
      }
      context = await this.buildContext(input.missionId, currentVersion);
      validated = this.validator.validate(context, parsed.data);
      await this.recordValidatedProposal(started.repairAttemptId, validated);

      for (const broken of validated.broken) {
        if (broken.status === "RELEASED") {
          releasedReservationIds.push(broken.id);
          continue;
        }
        const released = await this.authority.release(broken.id, currentVersion);
        currentVersion = released.missionVersion;
        releasedReservationIds.push(broken.id);
      }

      currentVersion = await this.enterReserving(
        input.missionId,
        currentVersion,
        started.repairAttemptId,
        validated,
        releasedReservationIds,
      );

      for (const replacement of validated.replacements) {
        const reservation = await this.merchantAdapter.reserveOffer({
          missionId: input.missionId,
          offerId: replacement.offer.id,
          expectedMissionVersion: currentVersion,
          expectedOfferVersion: replacement.offer.version,
        });
        replacementReservations.push(reservation);
        currentVersion += 1;
        await this.database.insert(missionEvents).values({
          missionId: input.missionId,
          type: "REPAIR_REPLACEMENT_RESERVED",
          missionVersion: currentVersion,
          data: {
            repairAttemptId: started.repairAttemptId,
            brokenReservationId: replacement.brokenReservation.id,
            replacementReservationId: reservation.id,
            replacementOfferId: replacement.offer.id,
            amount: reservation.snapshot.reservedPrice,
            offerVersion: reservation.snapshot.offerVersion,
          },
        });
      }

      const finalValidation = await this.authority.validateMission(input.missionId, currentVersion);
      currentVersion = finalValidation.missionVersion;
      if (!finalValidation.valid || finalValidation.status !== "READY_TO_COMMIT") {
        throw new RepairError("REPAIR_RESERVATION_FAILED", "Repaired mission failed final validation", 409, {
          violations: finalValidation.violations,
        });
      }
      const [persisted] = await this.database.select().from(missions).where(eq(missions.id, input.missionId));
      await this.completeAttempt(
        started.repairAttemptId,
        persisted,
        validated,
        releasedReservationIds,
        replacementReservations,
      );
      return {
        repairAttemptId: started.repairAttemptId,
        missionId: input.missionId,
        previousVersion: input.expectedVersion,
        missionVersion: persisted.version,
        status: "READY_TO_COMMIT",
        preservedReservationIds: validated.preserved.map((item) => item.id),
        releasedReservationIds,
        replacementReservationIds: replacementReservations.map((item) => item.id),
        changedItemCount: validated.changedItemCount,
        previousReservedAmount: started.previousReservedAmount,
        newReservedAmount: persisted.reservedAmount,
        remainingAmount: persisted.budgetAmount - persisted.reservedAmount - persisted.committedAmount,
        committedAmount: persisted.committedAmount,
      };
    } catch (error) {
      let compensationError: unknown;
      for (const reservation of [...replacementReservations].reverse()) {
        try {
          currentVersion = await this.compensateReplacement(reservation.id, input.missionId);
        } catch (caught) {
          compensationError = caught;
          break;
        }
      }
      currentVersion = await this.leaveNonReady(input.missionId);
      await this.failAttempt(
        started.repairAttemptId,
        input.missionId,
        currentVersion,
        compensationError ?? error,
        proposal,
        releasedReservationIds,
        replacementReservations.map((item) => item.id),
      );
      if (compensationError) {
        throw new RepairError(
          "REPAIR_RESERVATION_FAILED",
          "Repair failed and replacement compensation was incomplete",
          500,
        );
      }
      throw error;
    }
  }

  async getLatestAttempt(missionId: string) {
    const [attempt] = await this.database
      .select()
      .from(missionRepairAttempts)
      .where(eq(missionRepairAttempts.missionId, missionId))
      .orderBy(desc(missionRepairAttempts.startedAt))
      .limit(1);
    return attempt ?? null;
  }

  private async startAttempt(input: { missionId: string; expectedVersion: number; requestKey?: string }) {
    return this.database.transaction(async (transaction) => {
      const [mission] = await transaction
        .select()
        .from(missions)
        .where(eq(missions.id, input.missionId))
        .for("update");
      if (!mission) throw new MissionError("MISSION_NOT_FOUND", "Mission not found", 404);
      if (input.requestKey) {
        const [existing] = await transaction
          .select({ id: missionRepairAttempts.id })
          .from(missionRepairAttempts)
          .where(
            and(
              eq(missionRepairAttempts.missionId, mission.id),
              eq(missionRepairAttempts.requestKey, input.requestKey),
            ),
          );
        if (existing) {
          throw new RepairError("DUPLICATE_REPAIR_REQUEST", "Repair request already exists", 409);
        }
      }
      if (mission.version !== input.expectedVersion) {
        throw new MissionError("STALE_PLAN", "Mission version does not match repair request", 409, {
          expectedVersion: input.expectedVersion,
          currentVersion: mission.version,
        });
      }
      if (mission.status !== "INVALIDATED") {
        throw new RepairError("MISSION_NOT_INVALIDATED", "Only invalidated missions can be repaired", 409);
      }
      assertTransition("INVALIDATED", "REPLANNING");
      const replanningVersion = mission.version + 1;
      await transaction
        .update(missions)
        .set({ status: "REPLANNING", version: replanningVersion, updatedAt: new Date() })
        .where(eq(missions.id, mission.id));
      const [attempt] = await transaction
        .insert(missionRepairAttempts)
        .values({
          missionId: mission.id,
          startingVersion: mission.version,
          requestKey: input.requestKey,
          plannerId: this.planner.plannerId,
          modelId: this.planner.modelId,
          inputSnapshot: { missionId: mission.id, missionVersion: replanningVersion },
          previousReservedAmount: mission.reservedAmount,
        })
        .returning({ id: missionRepairAttempts.id });
      await transaction.insert(missionEvents).values({
        missionId: mission.id,
        type: "MISSION_REPAIR_STARTED",
        missionVersion: replanningVersion,
        data: { repairAttemptId: attempt.id, previousReservedAmount: mission.reservedAmount },
      });
      return {
        repairAttemptId: attempt.id,
        replanningVersion,
        previousReservedAmount: mission.reservedAmount,
      };
    });
  }

  private async buildContext(missionId: string, expectedVersion: number): Promise<RepairContext> {
    const [mission, items] = await Promise.all([
      this.database.select().from(missions).where(eq(missions.id, missionId)).then((rows) => rows[0]),
      this.database.select().from(missionItems).where(eq(missionItems.missionId, missionId)),
    ]);
    if (!mission) throw new MissionError("MISSION_NOT_FOUND", "Mission not found", 404);
    if (mission.version !== expectedVersion) throw new MissionError("STALE_PLAN", "Mission changed during repair", 409);
    if (mission.status !== "REPLANNING") {
      throw new RepairError("MISSION_NOT_INVALIDATED", "Mission left REPLANNING", 409);
    }
    const reservationRows = await Promise.all(
      items.filter((item) => item.reservationId).map((item) => this.merchantAdapter.checkReservation(item.reservationId!)),
    );
    const attached = reservationRows.filter((item): item is MerchantReservation => item !== null);
    const missingCategories = new Set(
      items
        .filter((item) => item.required && !item.reservationId)
        .map((item) => item.category),
    );
    const previousAttempts =
      missingCategories.size > 0
        ? await this.database
            .select({ releasedReservationIds: missionRepairAttempts.releasedReservationIds })
            .from(missionRepairAttempts)
            .where(eq(missionRepairAttempts.missionId, missionId))
            .orderBy(desc(missionRepairAttempts.startedAt))
            .limit(10)
        : [];
    const previousAttempt = previousAttempts.find(
      (attempt) => attempt.releasedReservationIds.length > 0,
    );
    const previousReleased = previousAttempt
      ? await Promise.all(
          previousAttempt.releasedReservationIds.map((reservationId) =>
            this.merchantAdapter.checkReservation(reservationId),
          ),
        )
      : [];
    const retryBroken = previousReleased.filter(
      (item): item is MerchantReservation =>
        item !== null &&
        item.status === "RELEASED" &&
        missingCategories.has(item.currentOffer.category),
    );
    const isValid = (reservation: MerchantReservation) =>
      reservation.status === "HELD" &&
      !reservationTermsAreStale(reservation, reservation.currentOffer) &&
      reservation.currentOffer.available &&
      reservation.currentOffer.readyAt.getTime() <= mission.deadline.getTime() &&
      !(
        reservation.currentOffer.category === "RESTAURANT" &&
        mission.constraints.vegetarian === true &&
        reservation.currentOffer.vegetarian !== true
      ) &&
      !(
        reservation.currentOffer.category === "RESTAURANT" &&
        mission.constraints.people !== undefined &&
        (reservation.currentOffer.servesPeople === null ||
          reservation.currentOffer.servesPeople < mission.constraints.people)
      );
    const preserved = attached.filter(isValid);
    const broken = [...attached.filter((item) => !isValid(item)), ...retryBroken];
    if (broken.length === 0) {
      throw new RepairError("NO_BROKEN_RESERVATION", "Invalidated mission has no broken attached reservation", 409);
    }
    const allOffers = await this.merchantAdapter.searchOffers({ availableOnly: false });
    const attachedOfferIds = new Set([...attached, ...retryBroken].map((item) => item.offerId));
    const candidatesByReservation = new Map<string, MerchantOffer[]>();
    for (const reservation of broken) {
      const candidates = allOffers.filter(
        (offer) =>
          offer.id !== reservation.offerId &&
          !attachedOfferIds.has(offer.id) &&
          offer.category === reservation.currentOffer.category &&
          offer.available &&
          offer.readyAt.getTime() <= mission.deadline.getTime() &&
          !(
            offer.category === "RESTAURANT" &&
            mission.constraints.vegetarian === true &&
            offer.vegetarian !== true
          ) &&
          !(
            offer.category === "RESTAURANT" &&
            mission.constraints.people !== undefined &&
            (offer.servesPeople === null || offer.servesPeople < mission.constraints.people)
          ),
      );
      candidatesByReservation.set(reservation.id, candidates);
    }
    return {
      mission: {
        id: mission.id,
        version: mission.version,
        status: "REPLANNING",
        budgetAmount: mission.budgetAmount,
        reservedAmount: mission.reservedAmount,
        committedAmount: mission.committedAmount,
        deadline: mission.deadline,
        constraints: mission.constraints,
        requiredCategories: items.filter((item) => item.required).map((item) => item.category),
      },
      preserved,
      broken,
      candidatesByReservation,
    };
  }

  private toRepairInput(context: RepairContext): MissionRepairInput {
    const preservedTotalAmount = context.preserved.reduce((sum, item) => sum + item.snapshot.reservedPrice, 0);
    const ranked = enumerateRepairOptions({
      candidatesByReservation: context.candidatesByReservation,
      preservedTotalAmount,
      previousReservedAmount: context.mission.reservedAmount,
    }).filter(
      (option) => option.repairedTotalAmount + context.mission.committedAmount <= context.mission.budgetAmount,
    );
    if (ranked.length === 0) throw new RepairError("NO_VALID_REPAIR", "No valid repair fits authority", 409);
    return {
      mission: {
        id: context.mission.id,
        version: context.mission.version,
        budgetAmount: context.mission.budgetAmount,
        previousReservedAmount: context.mission.reservedAmount,
        deadline: context.mission.deadline.toISOString(),
        constraints: context.mission.constraints,
      },
      preservedReservations: context.preserved.map((item) => ({
        id: item.id,
        category: item.currentOffer.category,
        offerId: item.offerId,
        reservedPrice: item.snapshot.reservedPrice,
      })),
      brokenReservations: context.broken.map((item) => ({
        id: item.id,
        category: item.currentOffer.category,
        offerId: item.offerId,
        reservedPrice: item.snapshot.reservedPrice,
        observedOfferVersion: item.snapshot.offerVersion,
        currentOfferVersion: item.currentOffer.version,
      })),
      rankedOptions: ranked.map((option) => ({
        replacements: option.replacements.map((item) => ({
          brokenReservationId: item.brokenReservationId,
          offerId: item.offer.id,
          offerCode: item.offer.code,
          observedOfferVersion: item.offer.version,
          amount: item.offer.amount,
        })),
        changedItemCount: option.changedItemCount,
        repairedTotalAmount: option.repairedTotalAmount,
        score: option.score,
      })),
    };
  }

  private async recordValidatedProposal(attemptId: string, repair: ValidatedRepair) {
    await this.database.transaction(async (transaction) => {
      await transaction
        .update(missionRepairAttempts)
        .set({
          rawProposal: repair.proposal as unknown as Record<string, unknown>,
          validatedRepair: {
            ...repair.proposal,
            repairedTotalAmount: repair.repairedTotalAmount,
            changedItemCount: repair.changedItemCount,
          } as unknown as Record<string, unknown>,
          preservedReservationIds: repair.preserved.map((item) => item.id),
        })
        .where(eq(missionRepairAttempts.id, attemptId));
      await transaction.insert(missionEvents).values({
        missionId: repair.proposal.missionId,
        type: "REPAIR_PLAN_PROPOSED",
        missionVersion: repair.proposal.missionVersion,
        data: {
          repairAttemptId: attemptId,
          preservedReservationIds: repair.preserved.map((item) => item.id),
          replacementOfferIds: repair.replacements.map((item) => item.offer.id),
          repairedTotalAmount: repair.repairedTotalAmount,
          aiReportedTotalAmount: repair.proposal.proposedTotalAmount,
          changedItemCount: repair.changedItemCount,
        },
      });
    });
  }

  private async enterReserving(
    missionId: string,
    expectedVersion: number,
    attemptId: string,
    repair: ValidatedRepair,
    releasedReservationIds: string[],
  ): Promise<number> {
    return this.database.transaction(async (transaction) => {
      const [mission] = await transaction.select().from(missions).where(eq(missions.id, missionId)).for("update");
      if (!mission) throw new MissionError("MISSION_NOT_FOUND", "Mission not found", 404);
      if (mission.version !== expectedVersion) throw new MissionError("STALE_PLAN", "Mission changed during release", 409);
      if (mission.status !== "REPLANNING") throw new RepairError("MISSION_NOT_INVALIDATED", "Mission left REPLANNING", 409);
      assertTransition("REPLANNING", "RESERVING");
      const nextVersion = mission.version + 1;
      await transaction
        .update(missions)
        .set({ status: "RESERVING", version: nextVersion, updatedAt: new Date() })
        .where(eq(missions.id, missionId));
      for (const reservation of repair.preserved) {
        await transaction.insert(missionEvents).values({
          missionId,
          type: "REPAIR_PRESERVED_RESERVATION",
          missionVersion: nextVersion,
          data: { repairAttemptId: attemptId, reservationId: reservation.id },
        });
      }
      for (const reservationId of releasedReservationIds) {
        await transaction.insert(missionEvents).values({
          missionId,
          type: "REPAIR_RELEASED_RESERVATION",
          missionVersion: nextVersion,
          data: { repairAttemptId: attemptId, reservationId },
        });
      }
      return nextVersion;
    });
  }

  private async compensateReplacement(reservationId: string, missionId: string): Promise<number> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [mission] = await this.database.select().from(missions).where(eq(missions.id, missionId));
      try {
        const result = await this.authority.release(reservationId, mission.version);
        await this.database.insert(missionEvents).values({
          missionId,
          type: "REPAIR_COMPENSATED",
          missionVersion: result.missionVersion,
          data: { reservationId },
        });
        return result.missionVersion;
      } catch (error) {
        if (!(error instanceof MissionError) || error.code !== "STALE_PLAN") throw error;
      }
    }
    throw new RepairError("REPAIR_RESERVATION_FAILED", "Replacement compensation remained stale", 500);
  }

  private async leaveNonReady(missionId: string): Promise<number> {
    return this.database.transaction(async (transaction) => {
      const [mission] = await transaction.select().from(missions).where(eq(missions.id, missionId)).for("update");
      if (!mission) throw new MissionError("MISSION_NOT_FOUND", "Mission not found", 404);
      if (mission.status === "RESERVING") {
        assertTransition("RESERVING", "INVALIDATED");
        const nextVersion = mission.version + 1;
        await transaction
          .update(missions)
          .set({ status: "INVALIDATED", version: nextVersion, updatedAt: new Date() })
          .where(eq(missions.id, missionId));
        return nextVersion;
      }
      return mission.version;
    });
  }

  private async failAttempt(
    attemptId: string,
    missionId: string,
    missionVersion: number,
    error: unknown,
    proposal: unknown,
    releasedReservationIds: string[],
    replacementReservationIds: string[],
  ) {
    const code = errorCode(error);
    const [mission] = await this.database.select().from(missions).where(eq(missions.id, missionId));
    await this.database.transaction(async (transaction) => {
      await transaction
        .update(missionRepairAttempts)
        .set({
          status: isExpectedError(error) ? "REJECTED" : "FAILED",
          errorCode: code,
          rawProposal:
            proposal && typeof proposal === "object" ? (proposal as Record<string, unknown>) : undefined,
          releasedReservationIds,
          replacementReservationIds,
          finalReservedAmount: mission.reservedAmount,
          completedAt: new Date(),
        })
        .where(eq(missionRepairAttempts.id, attemptId));
      await transaction.insert(missionEvents).values({
        missionId,
        type: "MISSION_REPAIR_FAILED",
        missionVersion,
        data: { repairAttemptId: attemptId, errorCode: code, releasedReservationIds, replacementReservationIds },
      });
    });
  }

  private async completeAttempt(
    attemptId: string,
    mission: typeof missions.$inferSelect,
    repair: ValidatedRepair,
    releasedReservationIds: string[],
    replacementReservations: MerchantReservation[],
  ) {
    await this.database.transaction(async (transaction) => {
      await transaction
        .update(missionRepairAttempts)
        .set({
          status: "SUCCEEDED",
          releasedReservationIds,
          replacementReservationIds: replacementReservations.map((item) => item.id),
          finalReservedAmount: mission.reservedAmount,
          completedAt: new Date(),
        })
        .where(eq(missionRepairAttempts.id, attemptId));
      await transaction.insert(missionEvents).values([
        {
          missionId: mission.id,
          type: "MISSION_REPAIR_SUCCEEDED",
          missionVersion: mission.version,
          data: {
            repairAttemptId: attemptId,
            preservedReservationIds: repair.preserved.map((item) => item.id),
            releasedReservationIds,
            replacementReservationIds: replacementReservations.map((item) => item.id),
            changedItemCount: repair.changedItemCount,
            repairedTotalAmount: repair.repairedTotalAmount,
          },
        },
        {
          missionId: mission.id,
          type: "MISSION_READY_TO_COMMIT",
          missionVersion: mission.version,
          data: { repairAttemptId: attemptId, source: "REPAIR" },
        },
      ]);
    });
  }
}
