import type { MerchantCategory } from "@/services/authority-store";

export interface MerchantOffer {
  id: string;
  code: string | null;
  merchantId: string;
  merchantName: string;
  category: MerchantCategory;
  name: string;
  description: string | null;
  amount: number;
  readyAt: Date;
  available: boolean;
  version: number;
  vegetarian: boolean | null;
  servesPeople: number | null;
}

export type MerchantReservationStatus = "HELD" | "RELEASED" | "INVALID";

export interface MerchantReservation {
  id: string;
  missionId: string;
  offerId: string;
  merchantId: string;
  status: MerchantReservationStatus;
  snapshot: {
    reservedPrice: number;
    offerVersion: number;
    readyAt: Date;
    available: boolean;
    vegetarian: boolean | null;
    servesPeople: number | null;
  };
  currentOffer: MerchantOffer;
}

export interface OfferSearchQuery {
  category?: MerchantCategory;
  readyBy?: Date;
  availableOnly?: boolean;
}

export interface MerchantAdapter {
  searchOffers(query?: OfferSearchQuery): Promise<MerchantOffer[]>;
  getOffer(offerId: string): Promise<MerchantOffer | null>;
  reserveOffer(input: {
    missionId: string;
    offerId: string;
    expectedMissionVersion: number;
    expectedOfferVersion?: number;
  }): Promise<MerchantReservation>;
  releaseOffer(input: {
    reservationId: string;
    expectedMissionVersion: number;
  }): Promise<MerchantReservation>;
  checkReservation(reservationId: string): Promise<MerchantReservation | null>;
}
