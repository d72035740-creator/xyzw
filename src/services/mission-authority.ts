import { MissionError } from "@/domain/errors";
import { assertTransition } from "@/domain/mission-state";
import type {
  MissionAuthorityStore,
  MissionRecord,
  ReservationRecord,
} from "./authority-store";

function assertExpectedVersion(mission: MissionRecord, expectedVersion: number): void {
  if (mission.version !== expectedVersion) {
    throw new MissionError("STALE_PLAN", "Mission version does not match the current version", 409, {
      expectedVersion,
      currentVersion: mission.version,
    });
  }
}

function assertReservable(mission: MissionRecord): void {
  if (mission.status !== "RESERVING" && mission.status !== "REPLANNING") {
    throw new MissionError(
      "INVALID_MISSION_STATE",
      `Cannot reserve while mission is ${mission.status}`,
      409,
    );
  }
}

export interface ReserveResult {
  reservation: ReservationRecord;
  reservedAmount: number;
  remainingAmount: number;
  missionVersion: number;
}

export interface ReleaseResult {
  reservationId: string;
  reservedAmount: number;
  remainingAmount: number;
  missionVersion: number;
}

export interface MissionValidationResult {
  valid: boolean;
  status: "READY_TO_COMMIT" | "INVALIDATED";
  violations: string[];
  missionVersion: number;
}

export class MissionAuthority {
  constructor(private readonly store: MissionAuthorityStore) {}

  async reserve(
    missionId: string,
    offerId: string,
    expectedVersion: number,
    expectedOfferVersion?: number,
  ): Promise<ReserveResult> {
    return this.store.withMissionLock(missionId, async (transaction) => {
      const mission = transaction.mission;
      assertExpectedVersion(mission, expectedVersion);
      assertReservable(mission);

      const offer = await transaction.getOffer(offerId);
      if (!offer || !offer.available) {
        throw new MissionError("OFFER_NOT_FOUND", "Offer is unavailable or does not exist", 404);
      }
      if (expectedOfferVersion !== undefined && offer.version !== expectedOfferVersion) {
        throw new MissionError("STALE_OFFER", "Offer version does not match the observed version", 409, {
          expectedOfferVersion,
          currentOfferVersion: offer.version,
        });
      }
      if (!Number.isSafeInteger(offer.amount) || offer.amount <= 0) {
        throw new MissionError("MISSION_CONSTRAINT_VIOLATION", "Offer amount must be positive integer paise");
      }

      const nextReservedAmount = mission.reservedAmount + offer.amount;
      if (nextReservedAmount + mission.committedAmount > mission.budgetAmount) {
        throw new MissionError("BUDGET_EXCEEDED", "Reservation would exceed mission budget", 409, {
          budgetAmount: mission.budgetAmount,
          reservedAmount: mission.reservedAmount,
          requestedAmount: offer.amount,
          remainingAmount:
            mission.budgetAmount - mission.reservedAmount - mission.committedAmount,
        });
      }

      const item = await transaction.getItem(offer.category);
      if (!item) {
        throw new MissionError(
          "MISSION_CONSTRAINT_VIOLATION",
          `Mission does not require category ${offer.category}`,
        );
      }
      if (item.reservationId) {
        throw new MissionError(
          "CATEGORY_ALREADY_RESERVED",
          `Category ${offer.category} already has an active reservation`,
          409,
        );
      }

      const reservation = await transaction.insertReservation({
        missionId,
        offerId,
        merchantId: offer.merchantId,
        amount: offer.amount,
        offerVersion: offer.version,
        readyAt: offer.readyAt,
        offerAvailable: offer.available,
        offerVegetarian: offer.vegetarian,
        offerServesPeople: offer.servesPeople,
      });
      await transaction.updateItem(item.id, {
        reservationId: reservation.id,
        status: "RESERVED",
      });
      const nextVersion = mission.version + 1;
      await transaction.updateMission({ reservedAmount: nextReservedAmount, version: nextVersion });
      await transaction.appendEvent("RESERVATION_CREATED", nextVersion, {
        reservationId: reservation.id,
        offerId,
        amount: offer.amount,
      });
      await transaction.appendEvent("OFFER_RESERVED", nextVersion, {
        reservationId: reservation.id,
        offerId,
        merchantId: offer.merchantId,
        reservedPrice: offer.amount,
        reservedOfferVersion: offer.version,
        readyAt: offer.readyAt.toISOString(),
      });

      return {
        reservation,
        reservedAmount: nextReservedAmount,
        remainingAmount: mission.budgetAmount - nextReservedAmount - mission.committedAmount,
        missionVersion: nextVersion,
      };
    });
  }

  async release(reservationId: string, expectedVersion: number): Promise<ReleaseResult> {
    const snapshot = await this.store.getReservation(reservationId);
    if (!snapshot) {
      throw new MissionError("RESERVATION_NOT_FOUND", "Reservation not found", 404);
    }

    return this.store.withMissionLock(snapshot.missionId, async (transaction) => {
      const mission = transaction.mission;
      assertExpectedVersion(mission, expectedVersion);
      if (
        !["RESERVING", "READY_TO_COMMIT", "INVALIDATED", "REPLANNING", "PAYMENT_FAILED"].includes(
          mission.status,
        )
      ) {
        throw new MissionError(
          "INVALID_MISSION_STATE",
          `Cannot release a reservation while mission is ${mission.status}`,
          409,
        );
      }
      const reservation = await transaction.getReservation(reservationId);
      if (!reservation) {
        throw new MissionError("RESERVATION_NOT_FOUND", "Reservation not found", 404);
      }
      if (reservation.status !== "ACTIVE" && reservation.status !== "INVALID") {
        throw new MissionError(
          "INVALID_RESERVATION_STATE",
          `Reservation is already ${reservation.status}`,
          409,
        );
      }

      const itemRows = await transaction.listValidationItems();
      const item = itemRows.find((candidate) => candidate.reservationId === reservationId);
      if (!item) {
        throw new MissionError("MISSION_CONSTRAINT_VIOLATION", "Reservation is not attached to a mission item");
      }

      const nextReservedAmount = mission.reservedAmount - reservation.amount;
      if (nextReservedAmount < 0) {
        throw new MissionError("MISSION_CONSTRAINT_VIOLATION", "Reserved amount cannot become negative");
      }
      const nextVersion = mission.version + 1;
      const nextStatus = mission.status === "READY_TO_COMMIT" ? "INVALIDATED" : mission.status;
      if (nextStatus !== mission.status) assertTransition(mission.status, nextStatus);

      await transaction.updateReservation(reservationId, {
        status: "RELEASED",
        version: reservation.version + 1,
      });
      await transaction.updateItem(item.id, { reservationId: null, status: "REQUIRED" });
      await transaction.updateMission({
        reservedAmount: nextReservedAmount,
        status: nextStatus,
        version: nextVersion,
      });
      await transaction.appendEvent("RESERVATION_RELEASED", nextVersion, {
        reservationId,
        amount: reservation.amount,
        previousStatus: reservation.status,
      });

      return {
        reservationId,
        reservedAmount: nextReservedAmount,
        remainingAmount: mission.budgetAmount - nextReservedAmount - mission.committedAmount,
        missionVersion: nextVersion,
      };
    });
  }

  async remaining(missionId: string): Promise<number> {
    const mission = await this.store.getMission(missionId);
    if (!mission) throw new MissionError("MISSION_NOT_FOUND", "Mission not found", 404);
    return mission.budgetAmount - mission.reservedAmount - mission.committedAmount;
  }

  async validateMission(
    missionId: string,
    expectedVersion: number,
  ): Promise<MissionValidationResult> {
    return this.store.withMissionLock(missionId, async (transaction) => {
      const mission = transaction.mission;
      assertExpectedVersion(mission, expectedVersion);
      if (mission.status !== "RESERVING" && mission.status !== "READY_TO_COMMIT") {
        throw new MissionError(
          "INVALID_MISSION_STATE",
          `Cannot validate while mission is ${mission.status}`,
          409,
        );
      }

      const items = await transaction.listValidationItems();
      const violations: string[] = [];
      for (const item of items.filter((candidate) => candidate.required)) {
        if (!item.reservationId || item.reservationStatus !== "ACTIVE") {
          violations.push(`${item.category}: missing active reservation`);
          continue;
        }
        if (!item.offerAvailable) violations.push(`${item.category}: offer unavailable`);
        if (item.reservedAmount !== item.offerAmount) {
          violations.push(`${item.category}: offer price changed`);
        }
        if (!item.offerReadyAt || item.offerReadyAt > mission.deadline) {
          violations.push(`${item.category}: misses mission deadline`);
        }
      }
      if (mission.reservedAmount + mission.committedAmount > mission.budgetAmount) {
        violations.push("mission budget exceeded");
      }
      const reservationTotal = items.reduce((sum, item) => sum + (item.reservedAmount ?? 0), 0);
      if (reservationTotal !== mission.reservedAmount) {
        violations.push("reserved total does not match active mission items");
      }

      const valid = violations.length === 0;
      const nextStatus = valid ? "READY_TO_COMMIT" : "INVALIDATED";
      if (mission.status !== nextStatus) assertTransition(mission.status, nextStatus);
      const nextVersion = mission.version + 1;

      for (const item of items) {
        await transaction.updateItem(item.id, {
          reservationId: item.reservationId,
          status: valid ? "VALID" : "INVALID",
        });
      }
      await transaction.updateMission({ status: nextStatus, version: nextVersion });
      await transaction.appendEvent("MISSION_VALIDATED", nextVersion, { valid, violations });

      return { valid, status: nextStatus, violations, missionVersion: nextVersion };
    });
  }
}
