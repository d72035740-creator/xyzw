import { describe, expect, it } from "vitest";
import { repairMissionSchema } from "@/api/schemas";
import type { MerchantOffer, MerchantReservation } from "@/commerce/merchant-adapter";
import { MissionRepairValidator } from "./mission-repair-validator";
import { rankRepairOptions } from "./repair-ranking";
import type { MissionRepairProposal, RepairContext, RepairPlanOption } from "./repair-types";

function offer(
  code: string,
  category: MerchantOffer["category"],
  amount: number,
  readyAt: string,
  extra: Partial<MerchantOffer> = {},
): MerchantOffer {
  return {
    id: `${code}-id`,
    code,
    merchantId: `${category}-merchant`,
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
    ...extra,
  };
}

function reservation(id: string, currentOffer: MerchantOffer, status: MerchantReservation["status"], price = currentOffer.amount): MerchantReservation {
  return {
    id,
    missionId: "mission",
    offerId: currentOffer.id,
    merchantId: currentOffer.merchantId,
    status,
    snapshot: {
      reservedPrice: price,
      offerVersion: status === "INVALID" ? currentOffer.version - 1 : currentOffer.version,
      readyAt: new Date(currentOffer.readyAt),
      available: true,
      vegetarian: currentOffer.vegetarian,
      servesPeople: currentOffer.servesPeople,
    },
    currentOffer,
  };
}

const c1 = offer("C1", "CAKE", 125000, "2030-01-01T18:00:00+05:30");
const f1 = offer("F1", "FLOWERS", 85000, "2030-01-01T17:00:00+05:30");
const r1 = offer("R1", "RESTAURANT", 635000, "2030-01-01T19:30:00+05:30", { version: 2 });
const r2 = offer("R2", "RESTAURANT", 520000, "2030-01-01T19:45:00+05:30");
const r3 = offer("R3", "RESTAURANT", 490000, "2030-01-01T20:30:00+05:30");
const cake = reservation("cake-res", c1, "HELD");
const flowers = reservation("flower-res", f1, "HELD");
const broken = reservation("r1-res", r1, "INVALID", 555000);

function context(candidates = [r2]): RepairContext {
  return {
    mission: {
      id: "mission",
      version: 10,
      status: "REPLANNING",
      budgetAmount: 800000,
      reservedAmount: 765000,
      committedAmount: 0,
      deadline: new Date("2030-01-01T20:00:00+05:30"),
      constraints: { vegetarian: true, people: 4 },
      requiredCategories: ["CAKE", "FLOWERS", "RESTAURANT"],
    },
    preserved: [cake, flowers],
    broken: [broken],
    candidatesByReservation: new Map([[broken.id, candidates]]),
  };
}

function proposal(replacement = r2): MissionRepairProposal {
  return {
    missionId: "mission",
    missionVersion: 10,
    preserveReservationIds: [cake.id, flowers.id],
    replacements: [
      {
        brokenReservationId: broken.id,
        replacementOfferId: replacement.id,
        observedOfferVersion: replacement.version,
        reason: "replace broken restaurant",
        constraintMapping: { deadline: null, vegetarian: null, people: null },
      },
    ],
    rationale: "minimal repair",
    proposedTotalAmount: 1,
  };
}

const validator = new MissionRepairValidator();

describe("minimal mission repair", () => {
  it("validates canonical R1 -> R2 and recomputes 730000 instead of trusting AI total", () => {
    expect(validator.validate(context(), proposal())).toMatchObject({
      repairedTotalAmount: 730000,
      changedItemCount: 1,
    });
  });

  it("makes changed item count dominate cost when ranking complete repairs", () => {
    const option = (changedItemCount: number, repairedTotalAmount: number, key: string): RepairPlanOption => ({
      replacements: [],
      changedItemCount,
      repairedTotalAmount,
      additionalCostAmount: 0,
      constraintDegradationScore: 0,
      score: changedItemCount * 1_000_000_000,
      tieBreaker: key,
    });
    expect(rankRepairOptions([option(3, 600000, "all"), option(1, 730000, "R2")])[0].changedItemCount).toBe(1);
  });

  it("rejects a stale replacement version", () => {
    expect(() => validator.validate(context([{ ...r2, version: 2 }]), proposal())).toThrowError(
      expect.objectContaining({ code: "STALE_OFFER" }),
    );
  });

  it("rejects a persisted repaired total over budget", () => {
    const expensive = { ...r2, amount: 700000 };
    expect(() => validator.validate(context([expensive]), proposal(expensive))).toThrowError(
      expect.objectContaining({ code: "REPAIR_BUDGET_EXCEEDED" }),
    );
  });

  it("rejects cheaper R3 when it misses the inclusive deadline", () => {
    expect(() => validator.validate(context([r3]), proposal(r3))).toThrowError(
      expect.objectContaining({ code: "INVALID_REPAIR_PROPOSAL" }),
    );
  });

  it("rejects non-vegetarian and insufficient-capacity replacements", () => {
    const nonVeg = { ...r2, vegetarian: false };
    const tooSmall = { ...r2, servesPeople: 2 };
    expect(() => validator.validate(context([nonVeg]), proposal(nonVeg))).toThrowError();
    expect(() => validator.validate(context([tooSmall]), proposal(tooSmall))).toThrowError();
  });

  it("requires all unrelated valid reservations to remain preserved", () => {
    expect(() =>
      validator.validate(context(), { ...proposal(), preserveReservationIds: [cake.id] }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REPAIR_PROPOSAL" }));
  });

  it("rejects a valid but non-minimal higher-cost alternative", () => {
    const premium = offer("R4", "RESTAURANT", 540000, "2030-01-01T19:40:00+05:30");
    expect(() => validator.validate(context([r2, premium]), proposal(premium))).toThrowError(
      expect.objectContaining({ code: "NON_MINIMAL_REPAIR" }),
    );
  });

  it("rejects authoritative client repair economics", () => {
    expect(
      repairMissionSchema.safeParse({
        expectedVersion: 9,
        replacementOfferId: r2.id,
        price: 1,
        budget: 1,
        reservedAmount: 1,
      }).success,
    ).toBe(false);
  });
});
