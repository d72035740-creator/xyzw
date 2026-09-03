import { count, eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db, sqlClient } from "@/db/client";
import { missionEvents, missionItems, missions, offers, reservations } from "@/db/schema";
import { MissionAuthority } from "@/services/mission-authority";
import { PostgresMissionAuthorityStore } from "@/services/postgres-authority-store";
import { MockMerchantAdapter } from "./mock-merchant-adapter";

const adapter = new MockMerchantAdapter(db);
const authority = new MissionAuthority(new PostgresMissionAuthorityStore(db));
let missionId: string | undefined;
let originalR1: { id: string; amount: number; version: number } | undefined;

async function cleanup(): Promise<void> {
  if (missionId) {
    const id = missionId;
    await sqlClient.begin(async (transaction) => {
      await transaction.unsafe(
        'ALTER TABLE "mission_events" DISABLE TRIGGER "mission_events_append_only"',
      );
      await transaction`DELETE FROM mission_events WHERE mission_id = ${id}`;
      await transaction.unsafe(
        'ALTER TABLE "mission_events" ENABLE TRIGGER "mission_events_append_only"',
      );
      await transaction`DELETE FROM mission_items WHERE mission_id = ${id}`;
      await transaction`DELETE FROM reservations WHERE mission_id = ${id}`;
      await transaction`DELETE FROM missions WHERE id = ${id}`;
      if (originalR1) {
        await transaction`
          UPDATE offers
          SET amount = ${originalR1.amount}, version = ${originalR1.version}, updated_at = now()
          WHERE id = ${originalR1.id}
        `;
      }
    });
  }
  missionId = undefined;
  originalR1 = undefined;
}

afterEach(cleanup);
afterAll(async () => sqlClient.end());

describe("MockMerchantAdapter on live PostgreSQL", () => {
  it("invalidates only R1 after a persisted 555000 -> 635000 world change", async () => {
    const [c1] = await db.select().from(offers).where(eq(offers.code, "C1"));
    const [f1] = await db.select().from(offers).where(eq(offers.code, "F1"));
    const [r1] = await db.select().from(offers).where(eq(offers.code, "R1"));
    expect(c1).toBeDefined();
    expect(f1).toBeDefined();
    expect(r1).toMatchObject({ amount: 555000 });
    originalR1 = { id: r1.id, amount: r1.amount, version: r1.version };

    const [mission] = await db
      .insert(missions)
      .values({
        goal: "Milestone 2 R1 invalidation integration test",
        budgetAmount: 800000,
        deadline: new Date("2030-01-01T20:00:00+05:30"),
        status: "RESERVING",
      })
      .returning();
    missionId = mission.id;
    await db.insert(missionItems).values(
      ["CAKE", "FLOWERS", "RESTAURANT"].map((category) => ({
        missionId: mission.id,
        category: category as "CAKE" | "FLOWERS" | "RESTAURANT",
      })),
    );

    const cakeReservation = await adapter.reserveOffer({
      missionId: mission.id,
      offerId: c1.id,
      expectedMissionVersion: mission.version,
    });
    const afterCake = await authority.remaining(mission.id);
    expect(afterCake).toBe(675000);
    const missionAfterCake = await new PostgresMissionAuthorityStore(db).getMission(mission.id);
    const flowerReservation = await adapter.reserveOffer({
      missionId: mission.id,
      offerId: f1.id,
      expectedMissionVersion: missionAfterCake!.version,
    });
    const missionAfterFlower = await new PostgresMissionAuthorityStore(db).getMission(mission.id);
    const restaurantReservation = await adapter.reserveOffer({
      missionId: mission.id,
      offerId: r1.id,
      expectedMissionVersion: missionAfterFlower!.version,
    });
    const missionAfterReservations = await new PostgresMissionAuthorityStore(db).getMission(mission.id);
    const validation = await authority.validateMission(
      mission.id,
      missionAfterReservations!.version,
    );
    expect(validation).toMatchObject({ valid: true, status: "READY_TO_COMMIT" });

    const [beforeChange] = await db.select().from(missions).where(eq(missions.id, mission.id));
    expect(beforeChange).toMatchObject({
      status: "READY_TO_COMMIT",
      reservedAmount: 765000,
      committedAmount: 0,
    });
    const previousMissionVersion = beforeChange.version;

    const change = await adapter.simulateOfferChange(r1.id, r1.version, { amount: 635000 });
    expect(change).toMatchObject({ changed: true, changedFields: ["amount"] });
    expect(change.invalidations).toHaveLength(1);

    const [afterChange] = await db.select().from(missions).where(eq(missions.id, mission.id));
    const [currentR1] = await db.select().from(offers).where(eq(offers.id, r1.id));
    const checkedCake = await adapter.checkReservation(cakeReservation.id);
    const checkedFlowers = await adapter.checkReservation(flowerReservation.id);
    const checkedRestaurant = await adapter.checkReservation(restaurantReservation.id);
    expect(afterChange).toMatchObject({
      status: "INVALIDATED",
      version: previousMissionVersion + 1,
      reservedAmount: 765000,
      committedAmount: 0,
    });
    expect(currentR1).toMatchObject({ amount: 635000, version: r1.version + 1 });
    expect(checkedCake?.status).toBe("HELD");
    expect(checkedFlowers?.status).toBe("HELD");
    expect(checkedRestaurant).toMatchObject({
      status: "INVALID",
      snapshot: { reservedPrice: 555000, offerVersion: r1.version },
      currentOffer: { amount: 635000, version: r1.version + 1 },
    });

    const events = await db
      .select()
      .from(missionEvents)
      .where(eq(missionEvents.missionId, mission.id));
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "OFFER_PRICE_CHANGED",
        "RESERVATION_INVALIDATED",
        "MISSION_INVALIDATED",
      ]),
    );
    const priceEvent = events.find((event) => event.type === "OFFER_PRICE_CHANGED");
    expect(priceEvent?.data).toMatchObject({
      offerId: r1.id,
      merchantId: r1.merchantId,
      oldPrice: 555000,
      newPrice: 635000,
      oldOfferVersion: r1.version,
      newOfferVersion: r1.version + 1,
      reservationId: restaurantReservation.id,
      previousMissionVersion,
      newMissionVersion: previousMissionVersion + 1,
    });

    const [reservationCount] = await db
      .select({ value: count() })
      .from(reservations)
      .where(eq(reservations.missionId, mission.id));
    expect(reservationCount.value).toBe(3);
    await expect(
      authority.release(cakeReservation.id, previousMissionVersion),
    ).rejects.toMatchObject({ code: "STALE_PLAN" });
    const [afterStaleAttempt] = await db.select().from(missions).where(eq(missions.id, mission.id));
    expect(afterStaleAttempt).toMatchObject({ reservedAmount: 765000, committedAmount: 0 });

    console.log(
      `M2_INVALIDATION_RESULT r1Before=555000 r1After=635000 ` +
        `offerVersion=${r1.version}->${currentR1.version} ` +
        `mission=${beforeChange.status}@${previousMissionVersion}->${afterChange.status}@${afterChange.version} ` +
        `cake=${checkedCake?.status} flowers=${checkedFlowers?.status} restaurant=${checkedRestaurant?.status} ` +
        `reserved=${afterChange.reservedAmount} committed=${afterChange.committedAmount}`,
    );
  });
});
