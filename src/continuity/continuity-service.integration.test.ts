import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db, sqlClient } from "@/db/client";
import { missionOutcomeEvents, missions } from "@/db/schema";
import { ContinuityService } from "./continuity-service";

let missionId: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (!missionId) return;
  const id = missionId;
  await sqlClient.begin(async (transaction) => {
    await transaction.unsafe("ALTER TABLE mission_events DISABLE TRIGGER mission_events_append_only");
    await transaction.unsafe("ALTER TABLE mission_outcome_events DISABLE TRIGGER mission_outcome_events_append_only");
    await transaction`delete from mission_outcome_events where mission_id=${id}`;
    await transaction`delete from continuity_selections where mission_id=${id}`;
    await transaction`delete from market_offer_snapshots where mission_id=${id}`;
    await transaction`delete from market_searches where mission_id=${id}`;
    await transaction`delete from continuity_missions where mission_id=${id}`;
    await transaction`delete from mission_events where mission_id=${id}`;
    await transaction`delete from missions where id=${id}`;
    await transaction.unsafe("ALTER TABLE mission_events ENABLE TRIGGER mission_events_append_only");
    await transaction.unsafe("ALTER TABLE mission_outcome_events ENABLE TRIGGER mission_outcome_events_append_only");
  });
  missionId = undefined;
});

describe("MissionPay Continuity PostgreSQL smoke", () => {
  it("compiles an arbitrary mission, reserves bounded authority, minimally replaces, and revalidates", async () => {
    vi.stubEnv("MISSIONPAY_PLANNER_PROVIDER", "mock");
    vi.stubEnv("MISSIONPAY_MARKET_MODE", "sandbox");
    const service = new ContinuityService(db);
    const built = await service.build({ goal: "Build a gaming setup under ₹55,000 with a 144Hz monitor, mechanical keyboard, wireless mouse and ergonomic chair", maximumAuthorityPaise: 5_500_000, repairAllowancePaise: 100_000, location: "India" });
    missionId = built!.mission.id;
    expect(built!.spec.needs).toHaveLength(4);
    expect(built!.selections.filter((selection) => selection.status === "SELECTED")).toHaveLength(4);
    expect(built!.mission.reservedPaise + built!.mission.committedPaise).toBeLessThanOrEqual(5_500_000);
    const first = built!.selections[0];
    const repaired = await service.replace(missionId, first.needId, built!.mission.version);
    expect(repaired!.selections.filter((selection) => selection.status === "SELECTED")).toHaveLength(4);
    expect(repaired!.selections.filter((selection) => selection.status === "REPLACED")).toHaveLength(1);
    expect(repaired!.mission.reservedPaise).toBeLessThanOrEqual(5_500_000);
    const fresh = await service.revalidate(missionId, repaired!.mission.version);
    expect(fresh!.mission.status).toBe("READY_TO_COMMIT");
  });

  it("tracks degradation and bounded repair without changing captured authority", async () => {
    vi.stubEnv("MISSIONPAY_PLANNER_PROVIDER", "mock");
    vi.stubEnv("MISSIONPAY_MARKET_MODE", "sandbox");
    const service = new ContinuityService(db);
    const built = await service.build({ goal: "Buy event essentials under ₹20,000 with projector and wireless microphone", maximumAuthorityPaise: 2_000_000, repairAllowancePaise: 100_000 });
    missionId = built!.mission.id;
    const captured = built!.mission.reservedPaise;
    await db.update(missions).set({ status: "PAID", reservedAmount: 0, committedAmount: captured }).where(eq(missions.id, missionId));
    const degraded = await service.reportIssue(missionId, built!.selections[0].needId, "Item unavailable");
    expect(degraded!.outcomeStatus).toBe("DEGRADED");
    expect(degraded!.mission.committedPaise).toBe(captured);
    const repair = await service.replace(missionId, built!.selections[0].needId, degraded!.mission.version);
    expect(repair!.outcomeStatus).toBe("REPAIR_PAYMENT_REQUIRED");
    expect(repair!.mission.committedPaise).toBe(captured);
    expect(repair!.mission.reservedPaise).toBe(0);
  });

  it("keeps the outcome event ledger append-only", async () => {
    vi.stubEnv("MISSIONPAY_PLANNER_PROVIDER", "mock");
    vi.stubEnv("MISSIONPAY_MARKET_MODE", "sandbox");
    const service = new ContinuityService(db);
    const built = await service.build({ goal: "Buy a display under ₹10,000", maximumAuthorityPaise: 1_000_000 });
    missionId = built!.mission.id;
    await db.insert(missionOutcomeEvents).values({ missionId, type: "SMOKE_EVENT", data: { source: "test" } });
    await expect(db.update(missionOutcomeEvents).set({ type: "MUTATED" }).where(eq(missionOutcomeEvents.missionId, missionId))).rejects.toThrow();
    await expect(db.delete(missionOutcomeEvents).where(eq(missionOutcomeEvents.missionId, missionId))).rejects.toThrow();
    const persisted = await db.select().from(missionOutcomeEvents).where(eq(missionOutcomeEvents.missionId, missionId));
    expect(persisted).toHaveLength(1);
    expect(persisted[0].type).toBe("SMOKE_EVENT");
  });
});
