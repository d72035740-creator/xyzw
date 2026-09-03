import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { MerchantAdapter } from "@/commerce/merchant-adapter";
import { MockMerchantAdapter } from "@/commerce/mock-merchant-adapter";
import { db, sqlClient } from "@/db/client";
import {
  missionEvents,
  missionRepairAttempts,
  missions,
  offers,
  reservations,
} from "@/db/schema";
import { MissionPlanningService } from "@/planner/mission-planning-service";
import { MockMissionPlanner } from "@/planner/mock-mission-planner";
import { MissionAuthority } from "@/services/mission-authority";
import { MissionService } from "@/services/mission-service";
import { PostgresMissionAuthorityStore } from "@/services/postgres-authority-store";
import { MissionRepairService } from "./mission-repair-service";
import { MockMissionRepairPlanner } from "./mock-mission-repair-planner";

const adapter = new MockMerchantAdapter(db);
const authority = new MissionAuthority(new PostgresMissionAuthorityStore(db));
const missionService = new MissionService(db);
const missionIds = new Set<string>();
const originalOffers = new Map<
  string,
  {
    amount: number;
    available: boolean;
    readyAt: Date;
    vegetarian: boolean | null;
    servesPeople: number | null;
    version: number;
  }
>();

async function rememberOffer(code: string) {
  const [offer] = await db.select().from(offers).where(eq(offers.code, code));
  if (!originalOffers.has(offer.id)) {
    originalOffers.set(offer.id, {
      amount: offer.amount,
      available: offer.available,
      readyAt: offer.readyAt,
      vegetarian: offer.vegetarian,
      servesPeople: offer.servesPeople,
      version: offer.version,
    });
  }
  return offer;
}

async function createInvalidatedBirthday() {
  const mission = await missionService.create({
    goal: "Repair my birthday mission",
    budgetAmount: 800000,
    deadline: new Date("2030-01-01T20:00:00+05:30"),
    requiredCategories: ["CAKE", "FLOWERS", "RESTAURANT"],
    constraints: { vegetarian: true, people: 4 },
  });
  missionIds.add(mission.id);
  const planning = new MissionPlanningService(
    new MockMissionPlanner(),
    adapter,
    authority,
    db,
  );
  const planned = await planning.plan({ missionId: mission.id, expectedVersion: mission.version });
  expect(planned).toMatchObject({ status: "READY_TO_COMMIT", actualTotalAmount: 765000 });
  const r1 = await rememberOffer("R1");
  const r2 = await rememberOffer("R2");
  await adapter.simulateOfferChange(r1.id, r1.version, { amount: 635000 });
  const [invalidated] = await db.select().from(missions).where(eq(missions.id, mission.id));
  expect(invalidated).toMatchObject({ status: "INVALIDATED", reservedAmount: 765000, committedAmount: 0 });
  return { mission: invalidated, r1, r2 };
}

async function reservationStates(missionId: string) {
  return db
    .select({
      reservationId: reservations.id,
      status: reservations.status,
      amount: reservations.amount,
      code: offers.code,
    })
    .from(reservations)
    .innerJoin(offers, eq(reservations.offerId, offers.id))
    .where(eq(reservations.missionId, missionId));
}

async function cleanup() {
  const ids = [...missionIds];
  await sqlClient.begin(async (transaction) => {
    if (ids.length > 0) {
      await transaction`DELETE FROM mission_repair_attempts WHERE mission_id IN ${transaction(ids)}`;
      await transaction`DELETE FROM agent_runs WHERE mission_id IN ${transaction(ids)}`;
      await transaction.unsafe('ALTER TABLE "mission_events" DISABLE TRIGGER "mission_events_append_only"');
      await transaction`DELETE FROM mission_events WHERE mission_id IN ${transaction(ids)}`;
      await transaction.unsafe('ALTER TABLE "mission_events" ENABLE TRIGGER "mission_events_append_only"');
      await transaction`DELETE FROM mission_items WHERE mission_id IN ${transaction(ids)}`;
      await transaction`DELETE FROM reservations WHERE mission_id IN ${transaction(ids)}`;
      await transaction`DELETE FROM missions WHERE id IN ${transaction(ids)}`;
    }
    for (const [offerId, original] of originalOffers) {
      await transaction`
        UPDATE offers SET amount=${original.amount}, available=${original.available},
          ready_at=${original.readyAt.toISOString()}, vegetarian=${original.vegetarian},
          serves_people=${original.servesPeople}, version=${original.version}, updated_at=now()
        WHERE id=${offerId}
      `;
    }
  });
  missionIds.clear();
  originalOffers.clear();
}

afterEach(cleanup);
afterAll(async () => sqlClient.end());

describe("MissionRepairService on live PostgreSQL", () => {
  it("repairs only R1 with R2 and reconstructs the complete audit trail", async () => {
    const { mission } = await createInvalidatedBirthday();
    const service = new MissionRepairService(
      new MockMissionRepairPlanner(),
      adapter,
      authority,
      db,
    );
    const result = await service.repair({
      missionId: mission.id,
      expectedVersion: mission.version,
      requestKey: `repair-${mission.id}`,
    });
    const [persisted] = await db.select().from(missions).where(eq(missions.id, mission.id));
    const states = await reservationStates(mission.id);
    const [attempt] = await db
      .select()
      .from(missionRepairAttempts)
      .where(eq(missionRepairAttempts.missionId, mission.id));
    const events = await db.select().from(missionEvents).where(eq(missionEvents.missionId, mission.id));

    expect(result).toMatchObject({
      status: "READY_TO_COMMIT",
      previousVersion: 9,
      missionVersion: 14,
      changedItemCount: 1,
      previousReservedAmount: 765000,
      newReservedAmount: 730000,
      remainingAmount: 70000,
      committedAmount: 0,
    });
    expect(persisted).toMatchObject({
      status: "READY_TO_COMMIT",
      budgetAmount: 800000,
      reservedAmount: 730000,
      committedAmount: 0,
    });
    expect(states).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "C1", status: "ACTIVE", amount: 125000 }),
        expect.objectContaining({ code: "F1", status: "ACTIVE", amount: 85000 }),
        expect.objectContaining({ code: "R1", status: "RELEASED", amount: 555000 }),
        expect.objectContaining({ code: "R2", status: "ACTIVE", amount: 520000 }),
      ]),
    );
    expect(attempt).toMatchObject({
      status: "SUCCEEDED",
      previousReservedAmount: 765000,
      finalReservedAmount: 730000,
    });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "MISSION_PLANNING_STARTED",
        "MISSION_INVALIDATED",
        "MISSION_REPAIR_STARTED",
        "REPAIR_PLAN_PROPOSED",
        "REPAIR_PRESERVED_RESERVATION",
        "REPAIR_RELEASED_RESERVATION",
        "REPAIR_REPLACEMENT_RESERVED",
        "MISSION_REPAIR_SUCCEEDED",
        "MISSION_READY_TO_COMMIT",
      ]),
    );
    await expect(
      service.repair({
        missionId: mission.id,
        expectedVersion: mission.version,
        requestKey: `repair-${mission.id}`,
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_REPAIR_REQUEST" });
    expect((await reservationStates(mission.id)).filter((item) => item.code === "R2" && item.status === "ACTIVE")).toHaveLength(1);
    console.log(
      `M4_REPAIR_RESULT mission=${persisted.status}@${persisted.version} budget=${persisted.budgetAmount} ` +
        `reserved=${persisted.reservedAmount} committed=${persisted.committedAmount} remaining=${result.remainingAmount} ` +
        `C1=HELD F1=HELD R1=RELEASED R2=HELD changedItems=${result.changedItemCount}`,
    );
  });

  it("rejects stale mission authority before any repair mutation", async () => {
    const { mission } = await createInvalidatedBirthday();
    const service = new MissionRepairService(new MockMissionRepairPlanner(), adapter, authority, db);
    await expect(service.repair({ missionId: mission.id, expectedVersion: mission.version - 1 })).rejects.toMatchObject({
      code: "STALE_PLAN",
    });
    const [persisted] = await db.select().from(missions).where(eq(missions.id, mission.id));
    expect(persisted).toMatchObject({ status: "INVALIDATED", reservedAmount: 765000, committedAmount: 0 });
  });

  it("rejects R2 when its version changes after proposal observation", async () => {
    const { mission, r2 } = await createInvalidatedBirthday();
    const baselinePlanner = new MockMissionRepairPlanner();
    const planner = new MockMissionRepairPlanner(async (input) => {
      const oldProposal = await baselinePlanner.createRepair(input);
      await adapter.simulateOfferChange(r2.id, r2.version, { amount: r2.amount + 10000 });
      return oldProposal;
    });
    const service = new MissionRepairService(planner, adapter, authority, db);
    await expect(service.repair({ missionId: mission.id, expectedVersion: mission.version })).rejects.toMatchObject({
      code: "STALE_OFFER",
    });
    const [persisted] = await db.select().from(missions).where(eq(missions.id, mission.id));
    expect(persisted).toMatchObject({ status: "REPLANNING", reservedAmount: 765000, committedAmount: 0 });
    expect((await reservationStates(mission.id)).some((item) => item.code === "R2")).toBe(false);
  });

  it("keeps C1/F1 and accurate authority when R2 fails after R1 release", async () => {
    const { mission, r2 } = await createInvalidatedBirthday();
    let failed = false;
    const failingAdapter: MerchantAdapter = {
      searchOffers: (query) => adapter.searchOffers(query),
      getOffer: (offerId) => adapter.getOffer(offerId),
      checkReservation: (reservationId) => adapter.checkReservation(reservationId),
      releaseOffer: (input) => adapter.releaseOffer(input),
      reserveOffer: async (input) => {
        if (!failed && input.offerId === r2.id) {
          failed = true;
          await adapter.simulateOfferChange(r2.id, r2.version, { available: false });
        }
        return adapter.reserveOffer(input);
      },
    };
    const service = new MissionRepairService(
      new MockMissionRepairPlanner(),
      failingAdapter,
      authority,
      db,
    );
    await expect(service.repair({ missionId: mission.id, expectedVersion: mission.version })).rejects.toMatchObject({
      code: "OFFER_NOT_FOUND",
    });
    const [persisted] = await db.select().from(missions).where(eq(missions.id, mission.id));
    const states = await reservationStates(mission.id);
    expect(persisted).toMatchObject({ status: "INVALIDATED", reservedAmount: 210000, committedAmount: 0 });
    expect(states).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "C1", status: "ACTIVE" }),
        expect.objectContaining({ code: "F1", status: "ACTIVE" }),
        expect.objectContaining({ code: "R1", status: "RELEASED" }),
      ]),
    );
    expect(states.some((item) => item.code === "R2" && item.status === "ACTIVE")).toBe(false);

    const currentR2 = await adapter.getOffer(r2.id);
    await adapter.simulateOfferChange(r2.id, currentR2!.version, { available: true });
    const [retryMission] = await db.select().from(missions).where(eq(missions.id, mission.id));
    const retryService = new MissionRepairService(
      new MockMissionRepairPlanner(),
      adapter,
      authority,
      db,
    );
    const retried = await retryService.repair({
      missionId: mission.id,
      expectedVersion: retryMission.version,
    });
    expect(retried).toMatchObject({
      status: "READY_TO_COMMIT",
      newReservedAmount: 730000,
      remainingAmount: 70000,
      committedAmount: 0,
    });
    const retryStates = await reservationStates(mission.id);
    expect(retryStates.filter((item) => item.code === "R1" && item.status === "RELEASED")).toHaveLength(1);
    expect(retryStates.filter((item) => item.code === "R2" && item.status === "ACTIVE")).toHaveLength(1);
  });

  it("serializes concurrent repairs and creates one active R2 replacement", async () => {
    const { mission } = await createInvalidatedBirthday();
    const first = new MissionRepairService(new MockMissionRepairPlanner(), adapter, authority, db);
    const second = new MissionRepairService(new MockMissionRepairPlanner(), adapter, authority, db);
    const results = await Promise.allSettled([
      first.repair({ missionId: mission.id, expectedVersion: mission.version }),
      second.repair({ missionId: mission.id, expectedVersion: mission.version }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const states = await reservationStates(mission.id);
    expect(states.filter((item) => item.code === "R2" && item.status === "ACTIVE")).toHaveLength(1);
    const [persisted] = await db.select().from(missions).where(eq(missions.id, mission.id));
    expect(persisted).toMatchObject({ status: "READY_TO_COMMIT", reservedAmount: 730000, committedAmount: 0 });
  });

  it("has repair persistence and economic snapshot columns in the migrated database", async () => {
    const tables = await sqlClient<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name='mission_repair_attempts'
    `;
    const columns = await sqlClient<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='reservations'
        AND column_name IN ('offer_vegetarian', 'offer_serves_people')
    `;
    expect(tables).toHaveLength(1);
    expect(new Set(columns.map((item) => item.column_name))).toEqual(
      new Set(["offer_vegetarian", "offer_serves_people"]),
    );
  });
});
