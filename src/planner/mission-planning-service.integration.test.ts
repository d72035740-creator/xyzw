import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { MockMerchantAdapter } from "@/commerce/mock-merchant-adapter";
import type { MerchantAdapter } from "@/commerce/merchant-adapter";
import { db, sqlClient } from "@/db/client";
import { agentRuns, missionEvents, missions, offers, reservations } from "@/db/schema";
import { MissionAuthority } from "@/services/mission-authority";
import { MissionService } from "@/services/mission-service";
import { PostgresMissionAuthorityStore } from "@/services/postgres-authority-store";
import { MissionPlanningService } from "./mission-planning-service";
import { MockMissionPlanner } from "./mock-mission-planner";
import type { MissionPlanningInput, MissionPlanProposal } from "./planner-types";

const missionService = new MissionService(db);
const authority = new MissionAuthority(new PostgresMissionAuthorityStore(db));
const adapter = new MockMerchantAdapter(db);
const missionIds = new Set<string>();
let originalR1: { id: string; amount: number; available: boolean; version: number } | undefined;
let originalC1: { id: string; amount: number; available: boolean; version: number } | undefined;

function proposalFrom(input: MissionPlanningInput): MissionPlanProposal {
  const selected = ["C1", "F1", "R1"].map((code) => {
    const selectedOffer = input.offers.find((offer) => offer.code === code)!;
    return {
      offerId: selectedOffer.id,
      observedOfferVersion: selectedOffer.version,
      category: selectedOffer.category,
      reason: `Select ${code}`,
      constraintMapping: { deadline: "server validates", vegetarian: null, people: null },
    };
  });
  return {
    missionId: input.mission.id,
    missionVersion: input.mission.version,
    selectedOffers: selected,
    rationale: "Canonical birthday plan",
    totalAmount: 1,
  };
}

async function createBirthdayMission() {
  const mission = await missionService.create({
    goal: "Plan my birthday evening under ₹8,000 with cake, flowers and vegetarian dinner for four",
    budgetAmount: 800000,
    deadline: new Date("2030-01-01T20:00:00+05:30"),
    requiredCategories: ["CAKE", "FLOWERS", "RESTAURANT"],
    constraints: { vegetarian: true, people: 4 },
  });
  missionIds.add(mission.id);
  return mission;
}

async function cleanup() {
  const ids = [...missionIds];
  await sqlClient.begin(async (transaction) => {
    if (ids.length > 0) {
      await transaction`DELETE FROM agent_runs WHERE mission_id IN ${transaction(ids)}`;
      await transaction.unsafe('ALTER TABLE "mission_events" DISABLE TRIGGER "mission_events_append_only"');
      await transaction`DELETE FROM mission_events WHERE mission_id IN ${transaction(ids)}`;
      await transaction.unsafe('ALTER TABLE "mission_events" ENABLE TRIGGER "mission_events_append_only"');
      await transaction`DELETE FROM mission_items WHERE mission_id IN ${transaction(ids)}`;
      await transaction`DELETE FROM reservations WHERE mission_id IN ${transaction(ids)}`;
      await transaction`DELETE FROM missions WHERE id IN ${transaction(ids)}`;
    }
    if (originalR1) {
      await transaction`
        UPDATE offers SET amount=${originalR1.amount}, available=${originalR1.available},
          version=${originalR1.version}, updated_at=now() WHERE id=${originalR1.id}
      `;
    }
    if (originalC1) {
      await transaction`
        UPDATE offers SET amount=${originalC1.amount}, available=${originalC1.available},
          version=${originalC1.version}, updated_at=now() WHERE id=${originalC1.id}
      `;
    }
  });
  missionIds.clear();
  originalR1 = undefined;
  originalC1 = undefined;
}

afterEach(cleanup);
afterAll(async () => sqlClient.end());

describe("MissionPlanningService on live PostgreSQL", () => {
  it("executes the canonical structured plan and persists audit/run state", async () => {
    const mission = await createBirthdayMission();
    const service = new MissionPlanningService(
      new MockMissionPlanner(),
      adapter,
      authority,
      db,
    );
    const result = await service.plan({
      missionId: mission.id,
      expectedVersion: mission.version,
      requestKey: `canonical-${mission.id}`,
    });
    const [persisted] = await db.select().from(missions).where(eq(missions.id, mission.id));
    const held = await db.select().from(reservations).where(eq(reservations.missionId, mission.id));
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.missionId, mission.id));
    const events = await db.select().from(missionEvents).where(eq(missionEvents.missionId, mission.id));

    expect(result).toMatchObject({
      status: "READY_TO_COMMIT",
      actualTotalAmount: 765000,
      remainingAmount: 35000,
    });
    expect(persisted).toMatchObject({
      status: "READY_TO_COMMIT",
      budgetAmount: 800000,
      reservedAmount: 765000,
      committedAmount: 0,
    });
    expect(held).toHaveLength(3);
    expect(held.every((item) => item.status === "ACTIVE")).toBe(true);
    expect(run).toMatchObject({ status: "SUCCEEDED", plannerId: "mock-canonical" });
    expect(run.validatedProposal).toMatchObject({ actualTotalAmount: 765000 });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "MISSION_PLANNING_STARTED",
        "AI_PLAN_PROPOSED",
        "MISSION_RESERVING",
        "MISSION_READY_TO_COMMIT",
      ]),
    );

    await expect(
      service.plan({ missionId: mission.id, expectedVersion: mission.version, requestKey: `duplicate-${mission.id}` }),
    ).rejects.toMatchObject({ code: "STALE_PLAN" });
    expect(await db.select().from(reservations).where(eq(reservations.missionId, mission.id))).toHaveLength(3);
    console.log(
      `M3_CANONICAL_RESULT mission=${persisted.status}@${persisted.version} budget=${persisted.budgetAmount} ` +
        `reserved=${persisted.reservedAmount} committed=${persisted.committedAmount} remaining=${result.remainingAmount}`,
    );
  });

  it("rejects a stale merchant world before creating financial authority", async () => {
    const mission = await createBirthdayMission();
    const [r1] = await db.select().from(offers).where(eq(offers.code, "R1"));
    originalR1 = { id: r1.id, amount: r1.amount, available: r1.available, version: r1.version };
    const planner = new MockMissionPlanner(async (input) => {
      const oldProposal = proposalFrom(input);
      await adapter.simulateOfferChange(r1.id, r1.version, { amount: r1.amount + 10000 });
      return oldProposal;
    });
    const service = new MissionPlanningService(planner, adapter, authority, db);

    await expect(service.plan({ missionId: mission.id, expectedVersion: mission.version })).rejects.toMatchObject({
      code: "STALE_OFFER",
    });
    const [persisted] = await db.select().from(missions).where(eq(missions.id, mission.id));
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.missionId, mission.id));
    expect(persisted).toMatchObject({ reservedAmount: 0, committedAmount: 0, status: "PLANNING" });
    expect(await db.select().from(reservations).where(eq(reservations.missionId, mission.id))).toHaveLength(0);
    expect(run).toMatchObject({ status: "REJECTED", errorCode: "STALE_OFFER" });
  });

  it("records a deterministically rejected hallucinated planner output", async () => {
    const mission = await createBirthdayMission();
    const planner = new MockMissionPlanner((input) => ({
      ...proposalFrom(input),
      selectedOffers: [
        ...proposalFrom(input).selectedOffers.slice(0, 2),
        {
          offerId: "hallucinated-offer-id",
          observedOfferVersion: 1,
          category: "RESTAURANT",
          reason: "invented",
          constraintMapping: { deadline: null, vegetarian: null, people: null },
        },
      ],
    }));
    const service = new MissionPlanningService(planner, adapter, authority, db);
    await expect(service.plan({ missionId: mission.id, expectedVersion: mission.version })).rejects.toMatchObject({
      code: "HALLUCINATED_OFFER",
    });
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.missionId, mission.id));
    expect(run).toMatchObject({ status: "REJECTED", errorCode: "HALLUCINATED_OFFER" });
    expect(await db.select().from(reservations).where(eq(reservations.missionId, mission.id))).toHaveLength(0);
  });

  it("compensates only reservations created before a late R1 failure", async () => {
    const mission = await createBirthdayMission();
    const [r1] = await db.select().from(offers).where(eq(offers.code, "R1"));
    originalR1 = { id: r1.id, amount: r1.amount, available: r1.available, version: r1.version };
    let failed = false;
    const failingAdapter: MerchantAdapter = {
      searchOffers: (query) => adapter.searchOffers(query),
      getOffer: (offerId) => adapter.getOffer(offerId),
      checkReservation: (reservationId) => adapter.checkReservation(reservationId),
      releaseOffer: (input) => adapter.releaseOffer(input),
      reserveOffer: async (input) => {
        if (!failed && input.offerId === r1.id) {
          failed = true;
          await adapter.simulateOfferChange(r1.id, r1.version, { available: false });
        }
        return adapter.reserveOffer(input);
      },
    };
    const service = new MissionPlanningService(
      new MockMissionPlanner(),
      failingAdapter,
      authority,
      db,
    );

    await expect(service.plan({ missionId: mission.id, expectedVersion: mission.version })).rejects.toMatchObject({
      code: "OFFER_NOT_FOUND",
    });
    const [persisted] = await db.select().from(missions).where(eq(missions.id, mission.id));
    const created = await db.select().from(reservations).where(eq(reservations.missionId, mission.id));
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.missionId, mission.id));
    const events = await db.select().from(missionEvents).where(eq(missionEvents.missionId, mission.id));
    expect(persisted).toMatchObject({ status: "INVALIDATED", reservedAmount: 0, committedAmount: 0 });
    expect(created).toHaveLength(2);
    expect(created.every((item) => item.status === "RELEASED")).toBe(true);
    expect(run).toMatchObject({ status: "REJECTED", errorCode: "OFFER_NOT_FOUND" });
    expect(events.map((event) => event.type)).toContain("PLAN_RESERVATION_COMPENSATED");
  });

  it("compensates safely when final validation detects changed persisted terms", async () => {
    const mission = await createBirthdayMission();
    const [c1] = await db.select().from(offers).where(eq(offers.code, "C1"));
    originalC1 = { id: c1.id, amount: c1.amount, available: c1.available, version: c1.version };
    class LateChangeAuthority extends MissionAuthority {
      override async validateMission(missionId: string, expectedVersion: number) {
        await db
          .update(offers)
          .set({ amount: c1.amount + 1, version: c1.version + 1 })
          .where(eq(offers.id, c1.id));
        return super.validateMission(missionId, expectedVersion);
      }
    }
    const lateAuthority = new LateChangeAuthority(new PostgresMissionAuthorityStore(db));
    const service = new MissionPlanningService(
      new MockMissionPlanner(),
      adapter,
      lateAuthority,
      db,
    );
    await expect(service.plan({ missionId: mission.id, expectedVersion: mission.version })).rejects.toMatchObject({
      code: "PLAN_EXECUTION_FAILED",
    });
    const [persisted] = await db.select().from(missions).where(eq(missions.id, mission.id));
    const created = await db.select().from(reservations).where(eq(reservations.missionId, mission.id));
    expect(persisted).toMatchObject({ status: "INVALIDATED", reservedAmount: 0, committedAmount: 0 });
    expect(created).toHaveLength(3);
    expect(created.every((item) => item.status === "RELEASED")).toBe(true);
    const events = await db.select().from(missionEvents).where(eq(missionEvents.missionId, mission.id));
    expect(events.map((event) => event.type)).toContain("PLAN_RESERVATION_COMPENSATED");
  });

  it("serializes duplicate planning requests so only one executes", async () => {
    const mission = await createBirthdayMission();
    const first = new MissionPlanningService(new MockMissionPlanner(), adapter, authority, db);
    const second = new MissionPlanningService(new MockMissionPlanner(), adapter, authority, db);
    const results = await Promise.allSettled([
      first.plan({ missionId: mission.id, expectedVersion: mission.version }),
      second.plan({ missionId: mission.id, expectedVersion: mission.version }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const active = (await db.select().from(reservations).where(eq(reservations.missionId, mission.id))).filter(
      (item) => item.status === "ACTIVE",
    );
    expect(active).toHaveLength(3);
  });
});
