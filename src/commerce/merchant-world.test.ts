import { describe, expect, it } from "vitest";
import type { MerchantOffer } from "./merchant-adapter";
import {
  applyEconomicChange,
  filterOffers,
  isReadyBy,
  planReservationInvalidation,
  reservationTermsAreStale,
  snapshotReservation,
} from "./merchant-world";

const deadline = new Date("2030-01-01T20:00:00+05:30");
const merchantIds = { CAKE: "cake-merchant", FLOWERS: "flower-merchant", RESTAURANT: "restaurant-merchant" };

function offer(
  code: string,
  category: MerchantOffer["category"],
  amount: number,
  readyAt: string,
): MerchantOffer {
  return {
    id: code,
    code,
    merchantId: merchantIds[category],
    merchantName: `${category} merchant`,
    category,
    name: code,
    description: null,
    amount,
    readyAt: new Date(readyAt),
    available: true,
    version: 1,
    vegetarian: category === "RESTAURANT" ? true : null,
    servesPeople: category === "RESTAURANT" ? 4 : null,
  };
}

const c1 = offer("C1", "CAKE", 125000, "2030-01-01T18:00:00+05:30");
const f1 = offer("F1", "FLOWERS", 85000, "2030-01-01T17:00:00+05:30");
const r1 = offer("R1", "RESTAURANT", 555000, "2030-01-01T19:30:00+05:30");
const r2 = offer("R2", "RESTAURANT", 520000, "2030-01-01T19:45:00+05:30");
const r3 = offer("R3", "RESTAURANT", 490000, "2030-01-01T20:30:00+05:30");
const world = [c1, f1, r1, r2, r3];

describe("deterministic merchant world", () => {
  it("A/B: searches and filters the three supported merchant categories", () => {
    expect(filterOffers(world, { category: "CAKE" }).map((item) => item.code)).toEqual(["C1"]);
    expect(filterOffers(world, { category: "FLOWERS" }).map((item) => item.code)).toEqual(["F1"]);
    expect(filterOffers(world, { category: "RESTAURANT" }).map((item) => item.code)).toEqual([
      "R1",
      "R2",
      "R3",
    ]);
  });

  it("C: uses inclusive readyTime <= deadline and rejects R3 at 20:30", () => {
    expect(isReadyBy(new Date("2030-01-01T20:00:00+05:30"), deadline)).toBe(true);
    expect(filterOffers([r1, r2, r3], { readyBy: deadline }).map((item) => item.code)).toEqual([
      "R1",
      "R2",
    ]);
  });

  it("D/E/F: snapshots immutable terms and increments only meaningful economic versions", () => {
    const reservation = snapshotReservation({ id: "reservation-r1", missionId: "mission", offer: r1 });
    const changed = applyEconomicChange(r1, { amount: 635000 });
    const noOp = applyEconomicChange(changed.newOffer, { amount: 635000 });
    expect(reservation.snapshot).toMatchObject({ reservedPrice: 555000, offerVersion: 1 });
    expect(changed.newOffer).toMatchObject({ amount: 635000, version: 2 });
    expect(reservation.snapshot).toMatchObject({ reservedPrice: 555000, offerVersion: 1 });
    expect(noOp.newOffer.version).toBe(2);
    expect(noOp.changedFields).toEqual([]);
  });

  it("increments versions for availability and readiness changes", () => {
    const unavailable = applyEconomicChange(r1, { available: false });
    expect(unavailable).toMatchObject({ changedFields: ["available"] });
    expect(unavailable.newOffer.version).toBe(2);
    const delayed = applyEconomicChange(unavailable.newOffer, {
      readyAt: new Date("2030-01-01T20:30:00+05:30"),
    });
    expect(delayed).toMatchObject({ changedFields: ["readyAt"] });
    expect(delayed.newOffer.version).toBe(3);
  });

  it("snapshots and invalidates vegetarian/capacity economic semantics", () => {
    const reservation = snapshotReservation({ id: "semantic-res", missionId: "mission", offer: r1 });
    const nonVegetarian = applyEconomicChange(r1, { vegetarian: false }).newOffer;
    const tooSmall = applyEconomicChange(r1, { servesPeople: 2 }).newOffer;
    expect(reservation.snapshot).toMatchObject({ vegetarian: true, servesPeople: 4 });
    expect(nonVegetarian.version).toBe(2);
    expect(tooSmall.version).toBe(2);
    expect(reservationTermsAreStale(reservation, nonVegetarian)).toBe(true);
    expect(reservationTermsAreStale(reservation, tooSmall)).toBe(true);
  });

  it("G-P: invalidates only stale R1 while preserving balances and unaffected holds", () => {
    const cakeReservation = snapshotReservation({ id: "cake-res", missionId: "mission", offer: c1 });
    const flowerReservation = snapshotReservation({ id: "flower-res", missionId: "mission", offer: f1 });
    const restaurantReservation = snapshotReservation({ id: "restaurant-res", missionId: "mission", offer: r1 });
    const changedR1 = applyEconomicChange(r1, { amount: 635000 }).newOffer;
    const mission = {
      id: "mission",
      status: "READY_TO_COMMIT" as const,
      version: 8,
      budgetAmount: 800000,
      reservedAmount: 765000,
      committedAmount: 0,
    };

    expect(reservationTermsAreStale(cakeReservation, c1)).toBe(false);
    expect(reservationTermsAreStale(flowerReservation, f1)).toBe(false);
    expect(reservationTermsAreStale(restaurantReservation, changedR1)).toBe(true);
    const plan = planReservationInvalidation({
      mission,
      reservation: restaurantReservation,
      oldOffer: r1,
      newOffer: changedR1,
    });
    expect(plan.affected).toBe(true);
    if (!plan.affected) throw new Error("Expected R1 invalidation");
    expect(plan.reservation.status).toBe("INVALID");
    expect(cakeReservation.status).toBe("HELD");
    expect(flowerReservation.status).toBe("HELD");
    expect(plan.mission).toMatchObject({ status: "INVALIDATED", version: 9 });
    expect(plan.mission.reservedAmount).toBe(765000);
    expect(plan.mission.committedAmount).toBe(0);
    expect(plan.eventData).toMatchObject({
      oldPrice: 555000,
      newPrice: 635000,
      oldOfferVersion: 1,
      newOfferVersion: 2,
      previousMissionVersion: 8,
      newMissionVersion: 9,
      hypotheticalReservedAmount: 845000,
    });
    expect("repair" in plan).toBe(false);
    expect("payment" in plan).toBe(false);
  });
});
