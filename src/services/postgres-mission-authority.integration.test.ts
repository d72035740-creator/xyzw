import { randomUUID } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db, sqlClient } from "@/db/client";
import {
  merchants,
  missionEvents,
  missionItems,
  missions,
  offers,
  reservations,
} from "@/db/schema";
import type { MerchantCategory } from "./authority-store";
import { MissionAuthority } from "./mission-authority";
import { PostgresMissionAuthorityStore } from "./postgres-authority-store";
import * as schema from "@/db/schema";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for PostgreSQL integration tests");

const authority = new MissionAuthority(new PostgresMissionAuthorityStore(db));
const testRunId = randomUUID();
const createdMissionIds = new Set<string>();
const createdOfferIds = new Set<string>();
const createdMerchantIds = new Set<string>();

async function createMission(
  categories: MerchantCategory[],
  budgetAmount: number,
  input: { reservedAmount?: number; committedAmount?: number; version?: number } = {},
) {
  const [mission] = await db
    .insert(missions)
    .values({
      goal: `MissionPay integration test ${testRunId}`,
      budgetAmount,
      reservedAmount: input.reservedAmount ?? 0,
      committedAmount: input.committedAmount ?? 0,
      deadline: new Date("2030-01-01T20:00:00+05:30"),
      status: "RESERVING",
      version: input.version ?? 1,
    })
    .returning();
  createdMissionIds.add(mission.id);
  await db.insert(missionItems).values(
    categories.map((category) => ({ missionId: mission.id, category })),
  );
  return mission;
}

async function createOffer(
  category: MerchantCategory,
  amount: number,
  label: string,
) {
  const [merchant] = await db
    .insert(merchants)
    .values({
      name: `MissionPay IT ${testRunId} ${label} ${randomUUID()}`,
      category,
    })
    .returning();
  createdMerchantIds.add(merchant.id);

  const [offer] = await db
    .insert(offers)
    .values({
      merchantId: merchant.id,
      name: `${label} ${randomUUID()}`,
      amount,
      readyAt: new Date("2030-01-01T19:00:00+05:30"),
    })
    .returning();
  createdOfferIds.add(offer.id);
  return offer;
}

async function expectPostgresError(
  operation: Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  try {
    await operation;
    throw new Error(`Expected PostgreSQL error ${expectedCode}`);
  } catch (error) {
    const postgresError =
      error instanceof Error && "cause" in error && error.cause ? error.cause : error;
    expect(postgresError).toMatchObject({ code: expectedCode });
  }
}

async function cleanupTestData(): Promise<void> {
  const missionIds = [...createdMissionIds];
  const offerIds = [...createdOfferIds];
  const merchantIds = [...createdMerchantIds];

  await sqlClient.begin(async (transaction) => {
    if (missionIds.length > 0) {
      // The ledger is deliberately immutable for ordinary roles. Tests temporarily disable
      // only this named trigger under an exclusive transactional lock to remove their own rows.
      await transaction.unsafe(
        'ALTER TABLE "mission_events" DISABLE TRIGGER "mission_events_append_only"',
      );
      await transaction`DELETE FROM mission_events WHERE mission_id IN ${transaction(missionIds)}`;
      await transaction.unsafe(
        'ALTER TABLE "mission_events" ENABLE TRIGGER "mission_events_append_only"',
      );
      await transaction`DELETE FROM mission_items WHERE mission_id IN ${transaction(missionIds)}`;
      await transaction`DELETE FROM reservations WHERE mission_id IN ${transaction(missionIds)}`;
      await transaction`DELETE FROM missions WHERE id IN ${transaction(missionIds)}`;
    }
    if (offerIds.length > 0) {
      await transaction`DELETE FROM offers WHERE id IN ${transaction(offerIds)}`;
    }
    if (merchantIds.length > 0) {
      await transaction`DELETE FROM merchants WHERE id IN ${transaction(merchantIds)}`;
    }
  });

  createdMissionIds.clear();
  createdOfferIds.clear();
  createdMerchantIds.clear();
}

afterEach(cleanupTestData);
afterAll(async () => sqlClient.end());

describe("PostgresMissionAuthorityStore on live PostgreSQL", () => {
  it("has the migrated tables and seeded merchant data", async () => {
    const tableRows = await sqlClient<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'missions', 'merchants', 'offers', 'reservations', 'mission_items', 'mission_events'
        )
    `;
    expect(new Set(tableRows.map((row) => row.table_name))).toEqual(
      new Set([
        "missions",
        "merchants",
        "offers",
        "reservations",
        "mission_items",
        "mission_events",
      ]),
    );
    const [seeded] = await db.select({ value: count() }).from(merchants);
    expect(seeded.value).toBeGreaterThanOrEqual(3);
  });

  it("A/B: reserves ₹7,650 and rejects another ₹500 without partial state", async () => {
    const mission = await createMission(["CAKE", "FLOWERS", "RESTAURANT"], 800000);
    const cake = await createOffer("CAKE", 125000, "cake");
    const flowers = await createOffer("FLOWERS", 85000, "flowers");
    const dinner = await createOffer("RESTAURANT", 555000, "dinner");
    const extra = await createOffer("CAKE", 50000, "extra");

    const cakeResult = await authority.reserve(mission.id, cake.id, mission.version);
    const flowerResult = await authority.reserve(
      mission.id,
      flowers.id,
      cakeResult.missionVersion,
    );
    const dinnerResult = await authority.reserve(
      mission.id,
      dinner.id,
      flowerResult.missionVersion,
    );
    expect(dinnerResult).toMatchObject({ reservedAmount: 765000, remainingAmount: 35000 });
    await expect(authority.remaining(mission.id)).resolves.toBe(35000);

    const [before] = await db
      .select({ value: count() })
      .from(reservations)
      .where(eq(reservations.missionId, mission.id));
    await expect(
      authority.reserve(mission.id, extra.id, dinnerResult.missionVersion),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    const [after] = await db
      .select({ value: count() })
      .from(reservations)
      .where(eq(reservations.missionId, mission.id));
    const [persisted] = await db.select().from(missions).where(eq(missions.id, mission.id));
    expect(after.value).toBe(before.value);
    expect(persisted.reservedAmount).toBe(765000);
  });

  it("C: prevents a genuine two-connection concurrent overspend", async () => {
    const mission = await createMission(["CAKE", "FLOWERS"], 100000);
    const offer70000 = await createOffer("CAKE", 70000, "race-70000");
    const offer60000 = await createOffer("FLOWERS", 60000, "race-60000");

    const clientA = postgres(databaseUrl, { max: 1, prepare: false });
    const clientB = postgres(databaseUrl, { max: 1, prepare: false });
    const authorityA = new MissionAuthority(
      new PostgresMissionAuthorityStore(drizzle(clientA, { schema })),
    );
    const authorityB = new MissionAuthority(
      new PostgresMissionAuthorityStore(drizzle(clientB, { schema })),
    );

    try {
      await Promise.all([clientA`SELECT 1`, clientB`SELECT 1`]);
      const [resultA, resultB] = await Promise.allSettled([
        authorityA.reserve(mission.id, offer70000.id, mission.version),
        authorityB.reserve(mission.id, offer60000.id, mission.version),
      ]);
      const results = [
        { amount: 70000, result: resultA },
        { amount: 60000, result: resultB },
      ];
      const succeeded = results.filter(({ result }) => result.status === "fulfilled");
      const failed = results.filter(({ result }) => result.status === "rejected");
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect(failed[0].result).toMatchObject({ reason: { code: "STALE_PLAN" } });

      const [persisted] = await db.select().from(missions).where(eq(missions.id, mission.id));
      const remainingAmount =
        persisted.budgetAmount - persisted.reservedAmount - persisted.committedAmount;
      expect(persisted.reservedAmount + persisted.committedAmount).toBeLessThanOrEqual(
        persisted.budgetAmount,
      );
      expect(persisted.reservedAmount).toBe(succeeded[0].amount);
      console.log(
        `CONCURRENCY_RESULT succeeded=${succeeded[0].amount} failed=${failed[0].amount} ` +
          `budget=${persisted.budgetAmount} reserved=${persisted.reservedAmount} ` +
          `committed=${persisted.committedAmount} remaining=${remainingAmount}`,
      );
    } finally {
      await Promise.all([clientA.end(), clientB.end()]);
    }
  });

  it("D/F: release restores authority once and double release changes nothing", async () => {
    const mission = await createMission(["CAKE"], 200000);
    const offer = await createOffer("CAKE", 125000, "release");
    const reserved = await authority.reserve(mission.id, offer.id, mission.version);
    const released = await authority.release(reserved.reservation.id, reserved.missionVersion);
    expect(released).toMatchObject({ reservedAmount: 0, remainingAmount: 200000 });

    await expect(
      authority.release(reserved.reservation.id, released.missionVersion),
    ).rejects.toMatchObject({ code: "INVALID_RESERVATION_STATE" });
    const [persistedMission] = await db.select().from(missions).where(eq(missions.id, mission.id));
    const [persistedReservation] = await db
      .select()
      .from(reservations)
      .where(eq(reservations.id, reserved.reservation.id));
    expect(persistedMission.reservedAmount).toBe(0);
    expect(persistedMission.version).toBe(released.missionVersion);
    expect(persistedReservation.status).toBe("RELEASED");
  });

  it("E: rejects a stale expectedVersion without financial changes", async () => {
    const mission = await createMission(["CAKE", "FLOWERS"], 300000);
    const cake = await createOffer("CAKE", 100000, "stale-cake");
    const flowers = await createOffer("FLOWERS", 50000, "stale-flowers");
    const versionN = mission.version;
    await authority.reserve(mission.id, cake.id, versionN);

    await expect(authority.reserve(mission.id, flowers.id, versionN)).rejects.toMatchObject({
      code: "STALE_PLAN",
    });
    const [persisted] = await db.select().from(missions).where(eq(missions.id, mission.id));
    const [reservationCount] = await db
      .select({ value: count() })
      .from(reservations)
      .where(eq(reservations.missionId, mission.id));
    expect(persisted.reservedAmount).toBe(100000);
    expect(persisted.version).toBe(versionN + 1);
    expect(reservationCount.value).toBe(1);
  });

  it("rejects invalid live financial values through PostgreSQL CHECK constraints", async () => {
    const mission = await createMission(["CAKE"], 100000);
    const offer = await createOffer("CAKE", 50000, "constraints");

    await expectPostgresError(
      db.update(missions).set({ reservedAmount: -1 }).where(eq(missions.id, mission.id)),
      "23514",
    );
    await expectPostgresError(
      db.update(missions).set({ committedAmount: -1 }).where(eq(missions.id, mission.id)),
      "23514",
    );
    await expectPostgresError(
      db
        .update(missions)
        .set({ reservedAmount: 70000, committedAmount: 40000 })
        .where(eq(missions.id, mission.id)),
      "23514",
    );
    await expectPostgresError(
      db.update(missions).set({ version: 0 }).where(eq(missions.id, mission.id)),
      "23514",
    );
    await expectPostgresError(
      db.insert(missions).values({
        goal: "invalid budget integration fixture",
        budgetAmount: 0,
        deadline: new Date("2030-01-01T20:00:00+05:30"),
      }),
      "23514",
    );
    await expectPostgresError(
      db.insert(offers).values({
        merchantId: offer.merchantId,
        name: `invalid-offer-${randomUUID()}`,
        amount: 0,
        readyAt: new Date("2030-01-01T19:00:00+05:30"),
      }),
      "23514",
    );
    await expectPostgresError(
      db.insert(reservations).values({ missionId: mission.id, offerId: offer.id, amount: 0 }),
      "23514",
    );

    const [persisted] = await db.select().from(missions).where(eq(missions.id, mission.id));
    expect(persisted).toMatchObject({
      budgetAmount: 100000,
      reservedAmount: 0,
      committedAmount: 0,
      version: 1,
    });
  });

  it("keeps mission_events append-only while allowing inserts", async () => {
    const mission = await createMission(["CAKE"], 100000);
    const [event] = await db
      .insert(missionEvents)
      .values({
        missionId: mission.id,
        type: "INTEGRATION_LEDGER_INSERT",
        missionVersion: mission.version,
        data: { testRunId },
      })
      .returning();

    await expectPostgresError(
      db
        .update(missionEvents)
        .set({ type: "ILLEGAL_UPDATE" })
        .where(eq(missionEvents.id, event.id)),
      "P0001",
    );
    await expectPostgresError(
      db.delete(missionEvents).where(eq(missionEvents.id, event.id)),
      "P0001",
    );
    await db.insert(missionEvents).values({
      missionId: mission.id,
      type: "INTEGRATION_LEDGER_SECOND_INSERT",
      missionVersion: mission.version,
      data: { testRunId },
    });

    const [eventCount] = await db
      .select({ value: count() })
      .from(missionEvents)
      .where(
        and(
          eq(missionEvents.missionId, mission.id),
          eq(missionEvents.missionVersion, mission.version),
        ),
      );
    expect(eventCount.value).toBe(2);
    console.log("APPEND_ONLY_RESULT insert=ok update=rejected delete=rejected rows=2");
  });
});
