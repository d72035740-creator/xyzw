import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
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
import { MissionAuthority } from "./mission-authority";

interface TestItem {
  id: string;
  missionId: string;
  category: MerchantCategory;
  required: boolean;
  reservationId: string | null;
  status: "REQUIRED" | "RESERVED" | "VALID" | "INVALID";
}

class InMemoryAuthorityStore implements MissionAuthorityStore {
  readonly missions = new Map<string, MissionRecord>();
  readonly offers = new Map<string, OfferRecord>();
  readonly reservations = new Map<string, ReservationRecord>();
  readonly items = new Map<string, TestItem>();
  private readonly lockTails = new Map<string, Promise<void>>();

  addMission(input: Partial<MissionRecord> = {}): MissionRecord {
    const mission: MissionRecord = {
      id: input.id ?? randomUUID(),
      budgetAmount: input.budgetAmount ?? 800000,
      reservedAmount: input.reservedAmount ?? 0,
      committedAmount: input.committedAmount ?? 0,
      deadline: input.deadline ?? new Date("2030-01-01T20:00:00+05:30"),
      status: input.status ?? "RESERVING",
      version: input.version ?? 1,
    };
    this.missions.set(mission.id, mission);
    return mission;
  }

  addOffer(category: MerchantCategory, amount: number, readyAt = "2030-01-01T19:00:00+05:30") {
    const offer: OfferRecord = {
      id: randomUUID(),
      merchantId: randomUUID(),
      category,
      amount,
      readyAt: new Date(readyAt),
      available: true,
      version: 1,
      vegetarian: category === "RESTAURANT" ? true : null,
      servesPeople: category === "RESTAURANT" ? 4 : null,
    };
    this.offers.set(offer.id, offer);
    return offer;
  }

  addItem(missionId: string, category: MerchantCategory): TestItem {
    const item: TestItem = {
      id: randomUUID(),
      missionId,
      category,
      required: true,
      reservationId: null,
      status: "REQUIRED",
    };
    this.items.set(item.id, item);
    return item;
  }

  async getMission(missionId: string): Promise<MissionRecord | null> {
    const mission = this.missions.get(missionId);
    return mission ? { ...mission } : null;
  }

  async getReservation(reservationId: string): Promise<ReservationRecord | null> {
    const reservation = this.reservations.get(reservationId);
    return reservation ? { ...reservation } : null;
  }

  async withMissionLock<T>(
    missionId: string,
    operation: (transaction: AuthorityTransaction) => Promise<T>,
  ): Promise<T> {
    const previous = this.lockTails.get(missionId) ?? Promise.resolve();
    let releaseLock!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    this.lockTails.set(missionId, previous.then(() => current));
    await previous;
    try {
      const mission = this.missions.get(missionId);
      if (!mission) throw new MissionError("MISSION_NOT_FOUND", "Mission not found", 404);
      return await operation(this.transactionFor(mission));
    } finally {
      releaseLock();
    }
  }

  private transactionFor(mission: MissionRecord): AuthorityTransaction {
    return {
      mission,
      getOffer: async (offerId) => this.offers.get(offerId) ?? null,
      getItem: async (category) =>
        [...this.items.values()].find(
          (item) => item.missionId === mission.id && item.category === category,
        ) ?? null,
      getReservation: async (reservationId) => this.reservations.get(reservationId) ?? null,
      listValidationItems: async () =>
        [...this.items.values()]
          .filter((item) => item.missionId === mission.id)
          .map((item): ValidationItem => {
            const reservation = item.reservationId
              ? this.reservations.get(item.reservationId)
              : undefined;
            const offer = reservation ? this.offers.get(reservation.offerId) : undefined;
            return {
              id: item.id,
              category: item.category,
              required: item.required,
              reservationId: item.reservationId,
              reservationStatus: reservation?.status ?? null,
              reservedAmount: reservation?.amount ?? null,
              offerAmount: offer?.amount ?? null,
              offerReadyAt: offer?.readyAt ?? null,
              offerAvailable: offer?.available ?? null,
            };
          }),
      insertReservation: async (input) => {
        const reservation: ReservationRecord = {
          id: randomUUID(),
          ...input,
          status: "ACTIVE",
          version: 1,
        };
        this.reservations.set(reservation.id, reservation);
        return reservation;
      },
      updateReservation: async (reservationId, values) => {
        Object.assign(this.reservations.get(reservationId)!, values);
      },
      updateItem: async (itemId, values) => {
        Object.assign(this.items.get(itemId)!, values);
      },
      updateMission: async (values) => {
        Object.assign(mission, values);
      },
      appendEvent: async () => undefined,
    };
  }
}

function demoFixture() {
  const store = new InMemoryAuthorityStore();
  const mission = store.addMission();
  for (const category of ["CAKE", "FLOWERS", "RESTAURANT"] as const) {
    store.addItem(mission.id, category);
  }
  const offers = {
    cake: store.addOffer("CAKE", 125000, "2030-01-01T18:00:00+05:30"),
    flowers: store.addOffer("FLOWERS", 85000, "2030-01-01T17:00:00+05:30"),
    dinner: store.addOffer("RESTAURANT", 555000, "2030-01-01T19:30:00+05:30"),
    extra: store.addOffer("CAKE", 50000),
  };
  return { store, mission, offers, authority: new MissionAuthority(store) };
}

async function reserveDemo() {
  const fixture = demoFixture();
  const cake = await fixture.authority.reserve(fixture.mission.id, fixture.offers.cake.id, 1);
  const flowers = await fixture.authority.reserve(
    fixture.mission.id,
    fixture.offers.flowers.id,
    cake.missionVersion,
  );
  const dinner = await fixture.authority.reserve(
    fixture.mission.id,
    fixture.offers.dinner.id,
    flowers.missionVersion,
  );
  return { ...fixture, cake, flowers, dinner };
}

describe("MissionAuthority", () => {
  it("A: reserves ₹7,650 from ₹8,000 and reports ₹350 remaining", async () => {
    const { authority, mission, dinner } = await reserveDemo();
    expect(dinner.reservedAmount).toBe(765000);
    expect(dinner.remainingAmount).toBe(35000);
    await expect(authority.remaining(mission.id)).resolves.toBe(35000);
  });

  it("B: rejects another ₹500 reservation with BUDGET_EXCEEDED", async () => {
    const { authority, mission, offers, dinner } = await reserveDemo();
    await expect(authority.reserve(mission.id, offers.extra.id, dinner.missionVersion)).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
    });
  });

  it("includes committed authority when enforcing and reporting the remaining budget", async () => {
    const store = new InMemoryAuthorityStore();
    const mission = store.addMission({ budgetAmount: 100000, committedAmount: 40000 });
    store.addItem(mission.id, "CAKE");
    const offer = store.addOffer("CAKE", 70000);
    const authority = new MissionAuthority(store);

    await expect(authority.reserve(mission.id, offer.id, mission.version)).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
      details: { remainingAmount: 60000 },
    });
    expect(store.missions.get(mission.id)?.reservedAmount).toBe(0);
  });

  it("C: serializes concurrent reservations so they cannot overspend", async () => {
    const store = new InMemoryAuthorityStore();
    const mission = store.addMission({ budgetAmount: 100000 });
    store.addItem(mission.id, "RESTAURANT");
    const firstOffer = store.addOffer("RESTAURANT", 60000);
    const secondOffer = store.addOffer("RESTAURANT", 60000);
    const authority = new MissionAuthority(store);

    const results = await Promise.allSettled([
      authority.reserve(mission.id, firstOffer.id, 1),
      authority.reserve(mission.id, secondOffer.id, 1),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(store.missions.get(mission.id)?.reservedAmount).toBe(60000);
    expect(store.missions.get(mission.id)?.reservedAmount).toBeLessThanOrEqual(100000);
  });

  it("D: releasing a reservation restores available authority", async () => {
    const { authority, mission, dinner } = await reserveDemo();
    const released = await authority.release(dinner.reservation.id, dinner.missionVersion);
    expect(released.reservedAmount).toBe(210000);
    expect(released.remainingAmount).toBe(590000);
    await expect(authority.remaining(mission.id)).resolves.toBe(590000);
  });

  it("E: rejects a financial mutation using a stale mission version", async () => {
    const { authority, dinner } = await reserveDemo();
    await expect(authority.release(dinner.reservation.id, dinner.missionVersion - 1)).rejects.toMatchObject({
      code: "STALE_PLAN",
    });
  });

  it("F: cannot release the same reservation twice", async () => {
    const { authority, dinner } = await reserveDemo();
    const released = await authority.release(dinner.reservation.id, dinner.missionVersion);
    await expect(authority.release(dinner.reservation.id, released.missionVersion)).rejects.toMatchObject({
      code: "INVALID_RESERVATION_STATE",
    });
  });

  it("releases an invalid reservation exactly once using its immutable amount", async () => {
    const { authority, store, dinner } = await reserveDemo();
    store.reservations.get(dinner.reservation.id)!.status = "INVALID";
    const released = await authority.release(dinner.reservation.id, dinner.missionVersion);
    expect(released.reservedAmount).toBe(210000);
    await expect(authority.release(dinner.reservation.id, released.missionVersion)).rejects.toMatchObject({
      code: "INVALID_RESERVATION_STATE",
    });
  });

  it("validates the complete mission as READY_TO_COMMIT", async () => {
    const { authority, mission, dinner } = await reserveDemo();
    const validation = await authority.validateMission(mission.id, dinner.missionVersion);
    expect(validation).toMatchObject({ valid: true, status: "READY_TO_COMMIT", violations: [] });
  });

  it("rejects an offer version that changed after planning", async () => {
    const { authority, mission, offers } = demoFixture();
    offers.cake.version = 2;
    await expect(authority.reserve(mission.id, offers.cake.id, mission.version, 1)).rejects.toMatchObject({
      code: "STALE_OFFER",
    });
    expect(await authority.remaining(mission.id)).toBe(800000);
  });

  it("accepts no caller-supplied price and reserves the persisted integer-paise amount", async () => {
    const { authority, mission, offers } = demoFixture();
    const result = await authority.reserve(mission.id, offers.cake.id, mission.version, offers.cake.version);
    expect(result.reservation.amount).toBe(125000);
    expect(result.reservedAmount).toBe(125000);
  });
});
