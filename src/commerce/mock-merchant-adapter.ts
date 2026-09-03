import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { db, type Database } from "@/db/client";
import { merchants, missionEvents, missionItems, missions, offers, reservations } from "@/db/schema";
import { assertTransition } from "@/domain/mission-state";
import { MissionAuthority } from "@/services/mission-authority";
import { PostgresMissionAuthorityStore } from "@/services/postgres-authority-store";
import { isMissionPaymentFrozen } from "@/payments/payment-freeze";
import type {
  MerchantAdapter,
  MerchantOffer,
  MerchantReservation,
  MerchantReservationStatus,
  OfferSearchQuery,
} from "./merchant-adapter";
import { MerchantError } from "./merchant-errors";
import { applyEconomicChange, type OfferChanges } from "./merchant-world";

type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

interface OfferRow {
  id: string;
  code: string | null;
  merchantId: string;
  merchantName: string;
  category: "CAKE" | "FLOWERS" | "RESTAURANT";
  name: string;
  description: string | null;
  amount: number;
  readyAt: Date;
  available: boolean;
  version: number;
  vegetarian: boolean | null;
  servesPeople: number | null;
}

function toOffer(row: OfferRow): MerchantOffer {
  return row;
}

function merchantStatus(status: typeof reservations.$inferSelect.status): MerchantReservationStatus {
  if (status === "ACTIVE") return "HELD";
  if (status === "RELEASED") return "RELEASED";
  return "INVALID";
}

class RetryWorldChange extends Error {}

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || !error) return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  if ("cause" in error) return postgresErrorCode(error.cause);
  return undefined;
}

export interface SimulateOfferChangeResult {
  changed: boolean;
  offer: MerchantOffer;
  changedFields: Array<"amount" | "available" | "readyAt" | "vegetarian" | "servesPeople">;
  invalidations: Array<{
    missionId: string;
    reservationId: string;
    previousMissionVersion: number;
    newMissionVersion: number;
    previousStatus: string;
    newStatus: "INVALIDATED";
  }>;
}

export class MockMerchantAdapter implements MerchantAdapter {
  private readonly authority: MissionAuthority;

  constructor(private readonly database: Database = db) {
    this.authority = new MissionAuthority(new PostgresMissionAuthorityStore(database));
  }

  async searchOffers(query: OfferSearchQuery = {}): Promise<MerchantOffer[]> {
    const conditions = [];
    if (query.category) conditions.push(eq(merchants.category, query.category));
    if (query.availableOnly !== false) conditions.push(eq(offers.available, true));
    if (query.readyBy) conditions.push(lte(offers.readyAt, query.readyBy));

    const rows = await this.database
      .select({
        id: offers.id,
        code: offers.code,
        merchantId: merchants.id,
        merchantName: merchants.name,
        category: merchants.category,
        name: offers.name,
        description: offers.description,
        amount: offers.amount,
        readyAt: offers.readyAt,
        available: offers.available,
        version: offers.version,
        vegetarian: offers.vegetarian,
        servesPeople: offers.servesPeople,
      })
      .from(offers)
      .innerJoin(merchants, eq(offers.merchantId, merchants.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(merchants.category), asc(offers.amount));
    return rows.map(toOffer);
  }

  async getOffer(offerId: string): Promise<MerchantOffer | null> {
    const [row] = await this.database
      .select({
        id: offers.id,
        code: offers.code,
        merchantId: merchants.id,
        merchantName: merchants.name,
        category: merchants.category,
        name: offers.name,
        description: offers.description,
        amount: offers.amount,
        readyAt: offers.readyAt,
        available: offers.available,
        version: offers.version,
        vegetarian: offers.vegetarian,
        servesPeople: offers.servesPeople,
      })
      .from(offers)
      .innerJoin(merchants, eq(offers.merchantId, merchants.id))
      .where(eq(offers.id, offerId));
    return row ? toOffer(row) : null;
  }

  async reserveOffer(input: {
    missionId: string;
    offerId: string;
    expectedMissionVersion: number;
    expectedOfferVersion?: number;
  }): Promise<MerchantReservation> {
    const result = await this.authority.reserve(
      input.missionId,
      input.offerId,
      input.expectedMissionVersion,
      input.expectedOfferVersion,
    );
    const reservation = await this.checkReservation(result.reservation.id);
    if (!reservation) {
      throw new MerchantError(
        "MERCHANT_RESERVATION_NOT_FOUND",
        "Reservation disappeared after creation",
        500,
      );
    }
    return reservation;
  }

  async releaseOffer(input: {
    reservationId: string;
    expectedMissionVersion: number;
  }): Promise<MerchantReservation> {
    await this.authority.release(input.reservationId, input.expectedMissionVersion);
    const reservation = await this.checkReservation(input.reservationId);
    if (!reservation) {
      throw new MerchantError("MERCHANT_RESERVATION_NOT_FOUND", "Reservation not found", 404);
    }
    return reservation;
  }

  async checkReservation(reservationId: string): Promise<MerchantReservation | null> {
    const [row] = await this.database
      .select({
        id: reservations.id,
        missionId: reservations.missionId,
        offerId: reservations.offerId,
        snapshotMerchantId: reservations.merchantId,
        reservedPrice: reservations.amount,
        snapshotOfferVersion: reservations.offerVersion,
        snapshotReadyAt: reservations.readyAt,
        snapshotAvailable: reservations.offerAvailable,
        snapshotVegetarian: reservations.offerVegetarian,
        snapshotServesPeople: reservations.offerServesPeople,
        reservationStatus: reservations.status,
        code: offers.code,
        merchantId: merchants.id,
        merchantName: merchants.name,
        category: merchants.category,
        name: offers.name,
        description: offers.description,
        amount: offers.amount,
        readyAt: offers.readyAt,
        available: offers.available,
        offerVersion: offers.version,
        vegetarian: offers.vegetarian,
        servesPeople: offers.servesPeople,
      })
      .from(reservations)
      .innerJoin(offers, eq(reservations.offerId, offers.id))
      .innerJoin(merchants, eq(offers.merchantId, merchants.id))
      .where(eq(reservations.id, reservationId));
    if (!row) return null;
    if (
      !row.snapshotMerchantId ||
      row.snapshotOfferVersion === null ||
      !row.snapshotReadyAt ||
      row.snapshotAvailable === null
    ) {
      throw new MerchantError(
        "INVALID_OFFER_CHANGE",
        "Legacy reservation does not contain a complete economic snapshot",
        409,
      );
    }

    return {
      id: row.id,
      missionId: row.missionId,
      offerId: row.offerId,
      merchantId: row.snapshotMerchantId,
      status: merchantStatus(row.reservationStatus),
      snapshot: {
        reservedPrice: row.reservedPrice,
        offerVersion: row.snapshotOfferVersion,
        readyAt: row.snapshotReadyAt,
        available: row.snapshotAvailable,
        vegetarian: row.snapshotVegetarian,
        servesPeople: row.snapshotServesPeople,
      },
      currentOffer: toOffer({
        id: row.offerId,
        code: row.code,
        merchantId: row.merchantId,
        merchantName: row.merchantName,
        category: row.category,
        name: row.name,
        amount: row.amount,
        readyAt: row.readyAt,
        available: row.available,
        version: row.offerVersion,
        description: row.description,
        vegetarian: row.vegetarian,
        servesPeople: row.servesPeople,
      }),
    };
  }

  async simulateOfferChange(
    offerId: string,
    expectedOfferVersion: number,
    changes: OfferChanges,
    targetMissionId?: string,
  ): Promise<SimulateOfferChangeResult> {
    if (changes.amount !== undefined && (!Number.isSafeInteger(changes.amount) || changes.amount <= 0)) {
      throw new MerchantError("INVALID_OFFER_CHANGE", "Offer amount must be positive integer paise");
    }
    if (changes.readyAt && Number.isNaN(changes.readyAt.getTime())) {
      throw new MerchantError("INVALID_OFFER_CHANGE", "readyAt must be a valid timestamp");
    }
    if (
      changes.servesPeople !== undefined &&
      changes.servesPeople !== null &&
      (!Number.isSafeInteger(changes.servesPeople) || changes.servesPeople <= 0)
    ) {
      throw new MerchantError("INVALID_OFFER_CHANGE", "servesPeople must be a positive integer or null");
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const knownMissionRows = await this.database
        .select({ missionId: reservations.missionId })
        .from(reservations)
        .where(and(eq(reservations.offerId, offerId), eq(reservations.status, "ACTIVE")));
      const knownMissionIds = [...new Set(knownMissionRows.map((row) => row.missionId))].sort();
      try {
        return await this.database.transaction((transaction) =>
          this.applyOfferChangeTransaction(
            transaction,
            offerId,
            expectedOfferVersion,
            changes,
            knownMissionIds,
            targetMissionId,
          ),
        );
      } catch (error) {
        if (error instanceof RetryWorldChange || postgresErrorCode(error) === "40P01") continue;
        throw error;
      }
    }
    throw new MerchantError(
      "INVALID_OFFER_CHANGE",
      "Offer world kept changing during invalidation; retry the operation",
      409,
    );
  }

  private async applyOfferChangeTransaction(
    transaction: DbTransaction,
    offerId: string,
    expectedOfferVersion: number,
    changes: OfferChanges,
    knownMissionIds: string[],
    targetMissionId?: string,
  ): Promise<SimulateOfferChangeResult> {
    const lockedMissions =
      knownMissionIds.length > 0
        ? await transaction
            .select()
            .from(missions)
            .where(inArray(missions.id, knownMissionIds))
            .orderBy(asc(missions.id))
            .for("update")
        : [];
    const targetMission = targetMissionId
      ? lockedMissions.find((mission) => mission.id === targetMissionId)
      : undefined;
    if (targetMission && isMissionPaymentFrozen(targetMission)) {
      throw new MerchantError("INVALID_OFFER_CHANGE", "Merchant terms are frozen while MissionPay payment is pending", 409);
    }

    const [offerRow] = await transaction
      .select({
        id: offers.id,
        code: offers.code,
        merchantId: merchants.id,
        merchantName: merchants.name,
        category: merchants.category,
        name: offers.name,
        description: offers.description,
        amount: offers.amount,
        readyAt: offers.readyAt,
        available: offers.available,
        version: offers.version,
        vegetarian: offers.vegetarian,
        servesPeople: offers.servesPeople,
      })
      .from(offers)
      .innerJoin(merchants, eq(offers.merchantId, merchants.id))
      .where(eq(offers.id, offerId))
      .for("update", { of: offers });
    if (!offerRow) {
      throw new MerchantError("MERCHANT_OFFER_NOT_FOUND", "Offer not found", 404);
    }
    if (offerRow.version !== expectedOfferVersion) {
      throw new MerchantError("STALE_OFFER", "Offer version is stale", 409, {
        expectedOfferVersion,
        currentOfferVersion: offerRow.version,
      });
    }

    const heldReservations = await transaction
      .select()
      .from(reservations)
      .where(and(eq(reservations.offerId, offerId), eq(reservations.status, "ACTIVE")))
      .for("update");
    const unknownMissionExists = heldReservations.some(
      (reservation) => !knownMissionIds.includes(reservation.missionId),
    );
    if (unknownMissionExists) throw new RetryWorldChange();

    const economicChange = applyEconomicChange(toOffer(offerRow), changes);
    if (economicChange.changedFields.length === 0) {
      return { changed: false, offer: economicChange.oldOffer, changedFields: [], invalidations: [] };
    }

    await transaction
      .update(offers)
      .set({
        amount: economicChange.newOffer.amount,
        available: economicChange.newOffer.available,
        readyAt: economicChange.newOffer.readyAt,
        vegetarian: economicChange.newOffer.vegetarian,
        servesPeople: economicChange.newOffer.servesPeople,
        version: economicChange.newOffer.version,
        updatedAt: new Date(),
      })
      .where(eq(offers.id, offerId));

    const missionById = new Map(lockedMissions.map((mission) => [mission.id, mission]));
    const invalidations: SimulateOfferChangeResult["invalidations"] = [];
    const frozenMissionIds = new Set(
      lockedMissions.filter(isMissionPaymentFrozen).map((mission) => mission.id),
    );
    // A held reservation belonging to another mission's active checkout is a
    // binding snapshot. Keep it untouched while invalidating mutable missions.
    const staleReservations = heldReservations.filter(
      (reservation) =>
        !frozenMissionIds.has(reservation.missionId) &&
        (reservation.offerVersion !== economicChange.newOffer.version ||
          reservation.amount !== economicChange.newOffer.amount ||
          reservation.offerAvailable !== economicChange.newOffer.available ||
          reservation.readyAt?.getTime() !== economicChange.newOffer.readyAt.getTime() ||
          reservation.offerVegetarian !== economicChange.newOffer.vegetarian ||
          reservation.offerServesPeople !== economicChange.newOffer.servesPeople),
    );
    const reservationsByMission = new Map<string, typeof staleReservations>();
    for (const reservation of staleReservations) {
      const grouped = reservationsByMission.get(reservation.missionId) ?? [];
      grouped.push(reservation);
      reservationsByMission.set(reservation.missionId, grouped);
    }
    for (const [missionId, missionReservations] of reservationsByMission) {
      const mission = missionById.get(missionId);
      if (!mission) throw new RetryWorldChange();
      const previousMissionVersion = mission.version;
      const previousMissionStatus = mission.status;
      const newMissionVersion = previousMissionVersion + 1;
      if (mission.status !== "INVALIDATED") assertTransition(mission.status, "INVALIDATED");

      for (const reservation of missionReservations) {
        await transaction
          .update(reservations)
          .set({ status: "INVALID", version: reservation.version + 1, updatedAt: new Date() })
          .where(eq(reservations.id, reservation.id));
      }
      await transaction
        .update(missionItems)
        .set({ status: "INVALID", updatedAt: new Date() })
        .where(inArray(missionItems.reservationId, missionReservations.map((item) => item.id)));
      await transaction
        .update(missions)
        .set({ status: "INVALIDATED", version: newMissionVersion, updatedAt: new Date() })
        .where(eq(missions.id, mission.id));

      const reason = economicChange.changedFields.map((field) => `${field.toUpperCase()}_CHANGED`).join("+");
      for (const reservation of missionReservations) {
        const eventData = {
          offerId,
          merchantId: offerRow.merchantId,
          reservationId: reservation.id,
          oldPrice: economicChange.oldOffer.amount,
          newPrice: economicChange.newOffer.amount,
          oldOfferVersion: economicChange.oldOffer.version,
          newOfferVersion: economicChange.newOffer.version,
          oldReadyAt: economicChange.oldOffer.readyAt.toISOString(),
          newReadyAt: economicChange.newOffer.readyAt.toISOString(),
          oldAvailable: economicChange.oldOffer.available,
          newAvailable: economicChange.newOffer.available,
          oldVegetarian: economicChange.oldOffer.vegetarian,
          newVegetarian: economicChange.newOffer.vegetarian,
          oldServesPeople: economicChange.oldOffer.servesPeople,
          newServesPeople: economicChange.newOffer.servesPeople,
          previousMissionVersion,
          newMissionVersion,
          reason,
        };
        await transaction.insert(missionEvents).values([
          {
            missionId: mission.id,
            type: economicChange.changedFields.includes("amount")
              ? "OFFER_PRICE_CHANGED"
              : "OFFER_TERMS_CHANGED",
            missionVersion: newMissionVersion,
            data: eventData,
          },
          {
            missionId: mission.id,
            type: "RESERVATION_INVALIDATED",
            missionVersion: newMissionVersion,
            data: eventData,
          },
        ]);
        invalidations.push({
          missionId: mission.id,
          reservationId: reservation.id,
          previousMissionVersion,
          newMissionVersion,
          previousStatus: previousMissionStatus,
          newStatus: "INVALIDATED",
        });
      }
      await transaction.insert(missionEvents).values({
        missionId: mission.id,
        type: "MISSION_INVALIDATED",
        missionVersion: newMissionVersion,
        data: {
          offerId,
          merchantId: offerRow.merchantId,
          reservationIds: missionReservations.map((item) => item.id),
          oldPrice: economicChange.oldOffer.amount,
          newPrice: economicChange.newOffer.amount,
          oldOfferVersion: economicChange.oldOffer.version,
          newOfferVersion: economicChange.newOffer.version,
          previousMissionVersion,
          newMissionVersion,
          reason,
          previousStatus: previousMissionStatus,
          newStatus: "INVALIDATED",
          reservedAmountUnchanged: mission.reservedAmount,
          committedAmountUnchanged: mission.committedAmount,
          hypotheticalReservedAmount:
            mission.reservedAmount -
            missionReservations.reduce((sum, item) => sum + item.amount, 0) +
            economicChange.newOffer.amount * missionReservations.length,
        },
      });
    }

    return {
      changed: true,
      offer: economicChange.newOffer,
      changedFields: economicChange.changedFields,
      invalidations,
    };
  }
}

export const mockMerchantAdapter = new MockMerchantAdapter();
