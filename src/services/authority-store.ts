import type { MissionStatus } from "@/domain/mission-state";

export type MerchantCategory = "CAKE" | "FLOWERS" | "RESTAURANT";
export type ReservationStatus = "ACTIVE" | "RELEASED" | "INVALID" | "COMMITTED" | "EXPIRED";

export interface MissionRecord {
  id: string;
  budgetAmount: number;
  reservedAmount: number;
  committedAmount: number;
  deadline: Date;
  status: MissionStatus;
  version: number;
}

export interface OfferRecord {
  id: string;
  merchantId: string;
  category: MerchantCategory;
  amount: number;
  readyAt: Date;
  available: boolean;
  version: number;
  vegetarian: boolean | null;
  servesPeople: number | null;
}

export interface ReservationRecord {
  id: string;
  missionId: string;
  offerId: string;
  merchantId: string | null;
  amount: number;
  offerVersion: number | null;
  readyAt: Date | null;
  offerAvailable: boolean | null;
  offerVegetarian: boolean | null;
  offerServesPeople: number | null;
  status: ReservationStatus;
  version: number;
}

export interface ValidationItem {
  id: string;
  category: MerchantCategory;
  required: boolean;
  reservationId: string | null;
  reservationStatus: ReservationStatus | null;
  reservedAmount: number | null;
  offerAmount: number | null;
  offerReadyAt: Date | null;
  offerAvailable: boolean | null;
}

export interface AuthorityTransaction {
  readonly mission: MissionRecord;
  getOffer(offerId: string): Promise<OfferRecord | null>;
  getItem(category: MerchantCategory): Promise<{ id: string; reservationId: string | null } | null>;
  getReservation(reservationId: string): Promise<ReservationRecord | null>;
  listValidationItems(): Promise<ValidationItem[]>;
  insertReservation(input: {
    missionId: string;
    offerId: string;
    merchantId: string;
    amount: number;
    offerVersion: number;
    readyAt: Date;
    offerAvailable: boolean;
    offerVegetarian: boolean | null;
    offerServesPeople: number | null;
  }): Promise<ReservationRecord>;
  updateReservation(reservationId: string, values: {
    status: ReservationStatus;
    version: number;
  }): Promise<void>;
  updateItem(itemId: string, values: {
    reservationId: string | null;
    status: "REQUIRED" | "RESERVED" | "VALID" | "INVALID";
  }): Promise<void>;
  updateMission(values: {
    reservedAmount?: number;
    status?: MissionStatus;
    version: number;
  }): Promise<void>;
  appendEvent(type: string, version: number, data?: Record<string, unknown>): Promise<void>;
}

export interface MissionAuthorityStore {
  getMission(missionId: string): Promise<MissionRecord | null>;
  getReservation(reservationId: string): Promise<ReservationRecord | null>;
  withMissionLock<T>(
    missionId: string,
    operation: (transaction: AuthorityTransaction) => Promise<T>,
  ): Promise<T>;
}
