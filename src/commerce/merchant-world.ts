import type { MerchantOffer, MerchantReservation } from "./merchant-adapter";
import type { MissionStatus } from "@/domain/mission-state";

export interface OfferChanges {
  amount?: number;
  available?: boolean;
  readyAt?: Date;
  vegetarian?: boolean | null;
  servesPeople?: number | null;
}

export interface EconomicChange {
  oldOffer: MerchantOffer;
  newOffer: MerchantOffer;
  changedFields: Array<"amount" | "available" | "readyAt" | "vegetarian" | "servesPeople">;
}

export function isReadyBy(readyAt: Date, deadline: Date): boolean {
  // MissionPay treats the deadline as inclusive: readyTime <= deadline.
  return readyAt.getTime() <= deadline.getTime();
}

export function filterOffers(
  offers: MerchantOffer[],
  query: { category?: MerchantOffer["category"]; readyBy?: Date; availableOnly?: boolean },
): MerchantOffer[] {
  return offers.filter((offer) => {
    if (query.category && offer.category !== query.category) return false;
    if (query.availableOnly !== false && !offer.available) return false;
    if (query.readyBy && !isReadyBy(offer.readyAt, query.readyBy)) return false;
    return true;
  });
}

export function applyEconomicChange(offer: MerchantOffer, changes: OfferChanges): EconomicChange {
  const changedFields: EconomicChange["changedFields"] = [];
  if (changes.amount !== undefined && changes.amount !== offer.amount) changedFields.push("amount");
  if (changes.available !== undefined && changes.available !== offer.available) {
    changedFields.push("available");
  }
  if (changes.readyAt && changes.readyAt.getTime() !== offer.readyAt.getTime()) {
    changedFields.push("readyAt");
  }
  if (changes.vegetarian !== undefined && changes.vegetarian !== offer.vegetarian) {
    changedFields.push("vegetarian");
  }
  if (changes.servesPeople !== undefined && changes.servesPeople !== offer.servesPeople) {
    changedFields.push("servesPeople");
  }

  return {
    oldOffer: offer,
    newOffer: {
      ...offer,
      amount: changes.amount ?? offer.amount,
      available: changes.available ?? offer.available,
      readyAt: changes.readyAt ?? offer.readyAt,
      vegetarian: changes.vegetarian === undefined ? offer.vegetarian : changes.vegetarian,
      servesPeople: changes.servesPeople === undefined ? offer.servesPeople : changes.servesPeople,
      version: changedFields.length > 0 ? offer.version + 1 : offer.version,
    },
    changedFields,
  };
}

export function reservationTermsAreStale(
  reservation: MerchantReservation,
  currentOffer: MerchantOffer,
): boolean {
  return (
    reservation.snapshot.offerVersion !== currentOffer.version ||
    reservation.snapshot.reservedPrice !== currentOffer.amount ||
    reservation.snapshot.available !== currentOffer.available ||
    reservation.snapshot.readyAt.getTime() !== currentOffer.readyAt.getTime()
    || reservation.snapshot.vegetarian !== currentOffer.vegetarian
    || reservation.snapshot.servesPeople !== currentOffer.servesPeople
  );
}

export function snapshotReservation(input: {
  id: string;
  missionId: string;
  offer: MerchantOffer;
}): MerchantReservation {
  return {
    id: input.id,
    missionId: input.missionId,
    offerId: input.offer.id,
    merchantId: input.offer.merchantId,
    status: "HELD",
    snapshot: {
      reservedPrice: input.offer.amount,
      offerVersion: input.offer.version,
      readyAt: new Date(input.offer.readyAt),
      available: input.offer.available,
      vegetarian: input.offer.vegetarian,
      servesPeople: input.offer.servesPeople,
    },
    currentOffer: input.offer,
  };
}

export interface MissionEconomicState {
  id: string;
  status: MissionStatus;
  version: number;
  budgetAmount: number;
  reservedAmount: number;
  committedAmount: number;
}

export function planReservationInvalidation(input: {
  mission: MissionEconomicState;
  reservation: MerchantReservation;
  oldOffer: MerchantOffer;
  newOffer: MerchantOffer;
}) {
  const { mission, reservation, oldOffer, newOffer } = input;
  const affected =
    reservation.status === "HELD" &&
    reservation.offerId === newOffer.id &&
    reservationTermsAreStale(reservation, newOffer);
  if (!affected) return { affected: false as const };

  return {
    affected: true as const,
    reservation: { ...reservation, status: "INVALID" as const, currentOffer: newOffer },
    mission: {
      ...mission,
      status: "INVALIDATED" as const,
      version: mission.version + 1,
    },
    eventData: {
      offerId: newOffer.id,
      merchantId: newOffer.merchantId,
      reservationId: reservation.id,
      oldPrice: oldOffer.amount,
      newPrice: newOffer.amount,
      oldOfferVersion: oldOffer.version,
      newOfferVersion: newOffer.version,
      previousMissionVersion: mission.version,
      newMissionVersion: mission.version + 1,
      reservedAmountUnchanged: mission.reservedAmount,
      committedAmountUnchanged: mission.committedAmount,
      hypotheticalReservedAmount:
        mission.reservedAmount - reservation.snapshot.reservedPrice + newOffer.amount,
    },
  };
}
