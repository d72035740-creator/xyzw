import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { MissionViewInput } from "./mission-view";
import type { MissionView as UiMissionView } from "@/components/mission-demo";
import { MissionControl } from "@/components/mission-demo";
import { isDemoMutationEnabled } from "@/demo/demo-safety";

vi.mock("server-only", () => ({}));

let buildMissionView: typeof import("./mission-view")["buildMissionView"];

beforeAll(async () => {
  ({ buildMissionView } = await import("./mission-view"));
});

const missionId = "10000000-0000-4000-8000-000000000001";
const createdAt = new Date("2030-01-01T10:00:00+05:30");
const deadline = new Date("2030-01-01T20:00:00+05:30");
const categories = ["CAKE", "FLOWERS", "RESTAURANT"] as const;

function input(state: "READY" | "INVALID" | "REPAIRED"): MissionViewInput {
  const repaired = state === "REPAIRED";
  const invalid = state === "INVALID";
  const baseReservations: MissionViewInput["reservations"] = [
    reservation("c1", "C1", "Chocolate Cake", "CAKE", 125000, 125000, "18:00", "ACTIVE"),
    reservation("f1", "F1", "Roses", "FLOWERS", 85000, 85000, "17:00", "ACTIVE"),
    reservation("r1", "R1", "Veg Dinner x4 — 7:30 PM", "RESTAURANT", 555000, invalid ? 635000 : 555000, "19:30", invalid ? "INVALID" : repaired ? "RELEASED" : "ACTIVE"),
  ];
  if (repaired) baseReservations.push(reservation("r2", "R2", "Veg Dinner x4 — 7:45 PM", "RESTAURANT", 520000, 520000, "19:45", "ACTIVE"));
  const currentIds = ["c1", "f1", repaired ? "r2" : "r1"];
  return {
    mission: {
      id: missionId, goal: "Plan my birthday evening under ₹8,000", budgetAmount: 800000,
      reservedAmount: repaired ? 730000 : 765000, committedAmount: 0, currency: "INR",
      deadline, constraints: { people: 4, vegetarian: true },
      status: invalid ? "INVALIDATED" : "READY_TO_COMMIT", version: repaired ? 14 : invalid ? 9 : 8,
      createdAt, updatedAt: createdAt,
    },
    items: categories.map((category, index) => ({
      id: `item-${index}`, missionId, category, required: true,
      reservationId: currentIds[index], status: invalid && category === "RESTAURANT" ? "INVALID" : "VALID",
      createdAt, updatedAt: createdAt,
    })),
    reservations: baseReservations,
    events: [
      { id: "event-1", missionId, type: "MISSION_CREATED", missionVersion: 1, data: {}, createdAt },
      { id: "event-2", missionId, type: repaired ? "MISSION_REPAIR_SUCCEEDED" : invalid ? "MISSION_INVALIDATED" : "MISSION_READY_TO_COMMIT", missionVersion: repaired ? 14 : invalid ? 9 : 8, data: invalid ? { oldPrice: 555000, newPrice: 635000 } : {}, createdAt: new Date(createdAt.getTime() + 1000) },
    ],
    latestPlan: {
      id: "run-1", missionId, missionVersion: 1, requestKey: null, plannerId: "mock", modelId: null,
      inputSnapshot: {}, rawOutput: {}, status: "SUCCEEDED", errorCode: null, startedAt: createdAt, completedAt: createdAt,
      validatedProposal: { rationale: "All three offers satisfy persisted constraints.", selectedOffers: baseReservations.slice(0, 3).map((r) => ({ offerId: r.offerId, reason: `${r.offerCode} meets category and deadline.` })) },
    },
    latestRepair: repaired ? {
      id: "repair-1", missionId, startingVersion: 9, requestKey: null, plannerId: "mock-repair", modelId: null,
      inputSnapshot: {}, rawProposal: {}, validatedRepair: { rationale: "Only dinner changed; C1 and F1 stay valid.", changedItemCount: 1 },
      preservedReservationIds: ["c1", "f1"], releasedReservationIds: ["r1"], replacementReservationIds: ["r2"],
      previousReservedAmount: 765000, finalReservedAmount: 730000, status: "SUCCEEDED", errorCode: null, startedAt: createdAt, completedAt: createdAt,
    } : null,
    demoMutationsEnabled: true,
    } as MissionViewInput;
}

function reservation(id: string, code: string, name: string, category: "CAKE" | "FLOWERS" | "RESTAURANT", reservedAmount: number, currentAmount: number, time: string, status: "ACTIVE" | "INVALID" | "RELEASED"): MissionViewInput["reservations"][number] {
  const readyAt = new Date(`2030-01-01T${time}:00+05:30`);
  return {
    id, offerId: `offer-${id}`, status, reservedAmount, snapshotReadyAt: readyAt,
    snapshotVegetarian: category === "RESTAURANT" ? true : null,
    snapshotServesPeople: category === "RESTAURANT" ? 4 : null,
    offerCode: code, offerName: name, currentAmount, currentReadyAt: readyAt,
    currentAvailable: true, currentVersion: currentAmount === reservedAmount ? 1 : 2,
    currentVegetarian: category === "RESTAURANT" ? true : null,
    currentServesPeople: category === "RESTAURANT" ? 4 : null,
    merchantName: category === "CAKE" ? "MissionPay Cakes" : category === "FLOWERS" ? "MissionPay Flowers" : "MissionPay Veg Kitchen",
    category,
  };
}

function html(view: UiMissionView): string {
  return renderToStaticMarkup(<MissionControl view={view} busy={null} error={null} onSimulate={() => undefined} onRepair={() => undefined} onPay={() => undefined} onReset={() => undefined} />);
}

describe("MissionView and demo UI", () => {
  it("derives persisted paise into the canonical ready read model and allowed actions", () => {
    const view = buildMissionView(input("READY"));
    expect(view.financialAuthority.authorized).toEqual({ amountPaise: 800000, display: "₹8,000" });
    expect(view.financialAuthority.reserved.display).toBe("₹7,650");
    expect(view.financialAuthority.remaining.display).toBe("₹350");
    expect(view.financialAuthority.committed.display).toBe("₹0");
    expect(view.availableActions).toMatchObject({ canPlan: false, canRepair: false, canSimulateMarketChange: true, canProceedToPayment: false });
    expect(view.mission.isProcessing).toBe(false);
  });

  it("renders C1, F1, and R1 from the persisted initial reservations", () => {
    const output = html(buildMissionView(input("READY")) as UiMissionView);
    expect(output).toContain("Chocolate Cake"); expect(output).toContain("Roses");
    expect(output).toContain("Veg Dinner x4"); expect(output).toContain("₹5,550");
  });

  it("shows the real invalidated restaurant price and ₹450 over-authority without payment action", () => {
    const view = buildMissionView(input("INVALID")); const output = html(view as UiMissionView);
    expect(view.financialAuthority.potential.display).toBe("₹8,450");
    expect(view.financialAuthority.overAuthority.display).toBe("₹450");
    expect(view.availableActions.canProceedToPayment).toBe(false);
    expect(view.availableActions.canRepair).toBe(true);
    expect(output).toContain("World state changed"); expect(output).toContain("₹6,350"); expect(output).toContain("+₹450");
  });

  it("renders preserved C1/F1, released R1, replacement R2, and final authority", () => {
    const view = buildMissionView(input("REPAIRED")); const output = html(view as UiMissionView);
    expect(view.financialAuthority.reserved.display).toBe("₹7,300");
    expect(view.financialAuthority.remaining.display).toBe("₹700");
    expect(view.financialAuthority.committed.display).toBe("₹0");
    expect(output).toContain("PRESERVED"); expect(output).toContain("R1"); expect(output).toContain("R2");
    expect(output).toContain("Only 1 component changed");
  });

  it("builds the timeline only from persisted mission events", () => {
    const view = buildMissionView(input("READY"));
    expect(view.timeline).toHaveLength(2);
    expect(view.timeline.map((event) => event.type)).toEqual(["MISSION_CREATED", "MISSION_READY_TO_COMMIT"]);
  });

  it("keeps demo-only mutation controls disabled outside explicitly enabled development", () => {
    expect(isDemoMutationEnabled({ NODE_ENV: "production", MISSIONPAY_ENABLE_DEV_WORLD_API: "true" })).toBe(false);
    expect(isDemoMutationEnabled({ NODE_ENV: "development", MISSIONPAY_ENABLE_DEV_WORLD_API: "false" })).toBe(false);
    expect(isDemoMutationEnabled({ NODE_ENV: "development", MISSIONPAY_ENABLE_DEV_WORLD_API: "true" })).toBe(true);
  });
});
