import { and, eq } from "drizzle-orm";
import { db, type Database } from "@/db/client";
import {
  merchants,
  missionEvents,
  missionItems,
  missions,
  offers,
  reservations,
} from "@/db/schema";
import { MissionError } from "@/domain/errors";
import type {
  AuthorityTransaction,
  MerchantCategory,
  MissionAuthorityStore,
  MissionRecord,
  OfferRecord,
  ReservationRecord,
  ValidationItem,
} from "./authority-store";

type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

function missionRecord(row: typeof missions.$inferSelect): MissionRecord {
  return {
    id: row.id,
    budgetAmount: row.budgetAmount,
    reservedAmount: row.reservedAmount,
    committedAmount: row.committedAmount,
    deadline: row.deadline,
    status: row.status,
    version: row.version,
  };
}

function reservationRecord(row: typeof reservations.$inferSelect): ReservationRecord {
  return {
    id: row.id,
    missionId: row.missionId,
    offerId: row.offerId,
    merchantId: row.merchantId,
    amount: row.amount,
    offerVersion: row.offerVersion,
    readyAt: row.readyAt,
    offerAvailable: row.offerAvailable,
    offerVegetarian: row.offerVegetarian,
    offerServesPeople: row.offerServesPeople,
    status: row.status,
    version: row.version,
  };
}

class PostgresAuthorityTransaction implements AuthorityTransaction {
  constructor(
    private readonly transaction: DbTransaction,
    public readonly mission: MissionRecord,
  ) {}

  async getOffer(offerId: string): Promise<OfferRecord | null> {
    const [row] = await this.transaction
      .select({
        id: offers.id,
        merchantId: merchants.id,
        category: merchants.category,
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
    return row ?? null;
  }

  async getItem(category: MerchantCategory) {
    const [row] = await this.transaction
      .select({ id: missionItems.id, reservationId: missionItems.reservationId })
      .from(missionItems)
      .where(and(eq(missionItems.missionId, this.mission.id), eq(missionItems.category, category)))
      .for("update");
    return row ?? null;
  }

  async getReservation(reservationId: string): Promise<ReservationRecord | null> {
    const [row] = await this.transaction
      .select()
      .from(reservations)
      .where(and(eq(reservations.id, reservationId), eq(reservations.missionId, this.mission.id)))
      .for("update");
    return row ? reservationRecord(row) : null;
  }

  async listValidationItems(): Promise<ValidationItem[]> {
    return this.transaction
      .select({
        id: missionItems.id,
        category: missionItems.category,
        required: missionItems.required,
        reservationId: missionItems.reservationId,
        reservationStatus: reservations.status,
        reservedAmount: reservations.amount,
        offerAmount: offers.amount,
        offerReadyAt: offers.readyAt,
        offerAvailable: offers.available,
      })
      .from(missionItems)
      .leftJoin(reservations, eq(missionItems.reservationId, reservations.id))
      .leftJoin(offers, eq(reservations.offerId, offers.id))
      .where(eq(missionItems.missionId, this.mission.id));
  }

  async insertReservation(input: {
    missionId: string;
    offerId: string;
    merchantId: string;
    amount: number;
    offerVersion: number;
    readyAt: Date;
    offerAvailable: boolean;
    offerVegetarian: boolean | null;
    offerServesPeople: number | null;
  }): Promise<ReservationRecord> {
    const [row] = await this.transaction.insert(reservations).values(input).returning();
    return reservationRecord(row);
  }

  async updateReservation(
    reservationId: string,
    values: { status: ReservationRecord["status"]; version: number },
  ): Promise<void> {
    await this.transaction
      .update(reservations)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(reservations.id, reservationId));
  }

  async updateItem(
    itemId: string,
    values: {
      reservationId: string | null;
      status: "REQUIRED" | "RESERVED" | "VALID" | "INVALID";
    },
  ): Promise<void> {
    await this.transaction
      .update(missionItems)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(missionItems.id, itemId));
  }

  async updateMission(values: {
    reservedAmount?: number;
    status?: MissionRecord["status"];
    version: number;
  }): Promise<void> {
    await this.transaction
      .update(missions)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(missions.id, this.mission.id));
    Object.assign(this.mission, values);
  }

  async appendEvent(
    type: string,
    version: number,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    await this.transaction.insert(missionEvents).values({
      missionId: this.mission.id,
      type,
      missionVersion: version,
      data,
    });
  }
}

export class PostgresMissionAuthorityStore implements MissionAuthorityStore {
  constructor(private readonly database: Database = db) {}

  async getMission(missionId: string): Promise<MissionRecord | null> {
    const [row] = await this.database.select().from(missions).where(eq(missions.id, missionId));
    return row ? missionRecord(row) : null;
  }

  async getReservation(reservationId: string): Promise<ReservationRecord | null> {
    const [row] = await this.database
      .select()
      .from(reservations)
      .where(eq(reservations.id, reservationId));
    return row ? reservationRecord(row) : null;
  }

  async withMissionLock<T>(
    missionId: string,
    operation: (transaction: AuthorityTransaction) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .select()
        .from(missions)
        .where(eq(missions.id, missionId))
        .for("update");
      if (!row) {
        throw new MissionError("MISSION_NOT_FOUND", "Mission not found", 404);
      }
      return operation(new PostgresAuthorityTransaction(transaction, missionRecord(row)));
    });
  }
}
