import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db, sqlClient } from "@/db/client";
import { continuityRepairAttempts, continuityRepairPaymentAttempts, continuityRepairPaymentOrders, missionOutcomeEvents, missionPaymentOrders, missions } from "@/db/schema";
import { ContinuityRepairPaymentService } from "@/payments/continuity-repair-payment-service";
import { MissionPaymentService } from "@/payments/mission-payment-service";
import type { PaymentProvider, ProviderPayment } from "@/payments/payment-provider";
import { ContinuityService } from "./continuity-service";

let missionId: string | undefined;
class RepairPaymentProvider implements PaymentProvider {
  readonly provider = "razorpay";
  readonly publicKeyId = "rzp_test_repair";
  payments = new Map<string, ProviderPayment>();
  calls = 0;
  async createOrder(input: { amount: number; currency: string }) { return { providerOrderId: `repair_order_${randomUUID()}_${++this.calls}`, amount: input.amount, currency: input.currency }; }
  async fetchPayment(paymentId: string) { return this.payments.get(paymentId) ?? { providerPaymentId: paymentId, providerOrderId: "missing", status: "created", amount: 0, currency: "INR" }; }
  async fetchOrder(orderId: string) { return { providerOrderId: orderId, status: "created" }; }
  verifyCheckoutSignature(input: { signature: string }) { return input.signature === "valid"; }
}
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (!missionId) return;
  const id = missionId;
  await sqlClient.begin(async (transaction) => {
    await transaction.unsafe("ALTER TABLE mission_events DISABLE TRIGGER mission_events_append_only");
    await transaction.unsafe("ALTER TABLE mission_outcome_events DISABLE TRIGGER mission_outcome_events_append_only");
    await transaction`delete from continuity_repair_payment_attempts where mission_id=${id}`;
    await transaction`delete from continuity_repair_payment_orders where mission_id=${id}`;
    await transaction`delete from continuity_repair_attempts where mission_id=${id}`;
    await transaction`delete from mission_payment_orders where mission_id=${id}`;
    await transaction`delete from mission_outcome_events where mission_id=${id}`;
    await transaction`delete from continuity_selections where mission_id=${id}`;
    await transaction`delete from product_evidence where mission_id=${id}`;
    await transaction`delete from candidate_assessments where mission_id=${id}`;
    await transaction`delete from decision_runs where mission_id=${id}`;
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
    const built = await service.build({ goal: "Build a gaming setup under ₹55,000 with a 144Hz monitor, mechanical keyboard, wireless mouse and ergonomic chair", maximumAuthorityPaise: 5_500_000, repairAllowancePaise: 100_000, location: { manualLabel: "Varanasi, Uttar Pradesh" } });
    missionId = built!.mission.id;
    expect(built!.spec.needs).toHaveLength(4);
    expect(built!.selections.filter((selection) => selection.status === "SELECTED")).toHaveLength(4);
    expect(built!.mission.reservedPaise + built!.mission.committedPaise).toBeLessThanOrEqual(5_500_000);
    const switched = await service.selectPortfolio(missionId, "CHEAPEST_VALID", built!.mission.version);
    expect(switched!.decision?.selectedPortfolio).toBe("CHEAPEST_VALID");
    expect(switched!.mission.version).toBe(built!.mission.version + 1);
    expect(switched!.selections.filter((selection) => selection.status === "SELECTED")).toHaveLength(4);
    const first = switched!.selections.find((selection) => selection.status === "SELECTED")!;
    const repaired = await service.replaceFresh(missionId, first.needId, switched!.mission.version);
    expect(repaired!.selections.filter((selection) => selection.status === "SELECTED")).toHaveLength(4);
    expect(repaired!.selections.filter((selection) => selection.status === "REPLACED")).toHaveLength(5);
    expect(repaired!.mission.reservedPaise).toBeLessThanOrEqual(5_500_000);
    expect(repaired!.spec.location).toEqual({ source: "manual", label: "Varanasi, Uttar Pradesh" });
    const fresh = await service.revalidate(missionId, repaired!.mission.version);
    expect(fresh!.mission.status).toBe("READY_TO_COMMIT");
    expect(fresh!.spec.location).toEqual(repaired!.spec.location);
  });

  it("performs a fresh live replacement search for only the affected need before whole-mission revalidation", async () => {
    vi.stubEnv("MISSIONPAY_PLANNER_PROVIDER", "mock");
    vi.stubEnv("MISSIONPAY_MARKET_MODE", "live");
    vi.stubEnv("SERPAPI_API_KEY", "test-only-key");
    const calls = new Map<string, number>();
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      const query = url.searchParams.get("q") ?? "";
      const call = (calls.get(query) ?? 0) + 1;
      if (url.searchParams.get("engine") === "google_shopping") calls.set(query, call);
      const affected = /144Hz monitor/i.test(query);
      const replacementSearch = affected && call >= 2 && url.searchParams.get("engine") === "google_shopping";
      return new Response(JSON.stringify({ shopping_results: [
        { product_id: `${query}-primary`, title: query, source: "Live Merchant A", extracted_price: 3000, product_link: `https://example.test/${encodeURIComponent(query)}/primary` },
        { product_id: replacementSearch ? `${query}-fresh-replacement` : `${query}-alternate`, title: query, source: "Live Merchant B", extracted_price: replacementSearch ? 3200 : 3500, product_link: `https://example.test/${encodeURIComponent(query)}/replacement` },
      ] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const service = new ContinuityService(db);
    const built = await service.build({ goal: "Build a gaming setup under ₹55,000 with a 144Hz monitor, mechanical keyboard, wireless mouse and ergonomic chair", maximumAuthorityPaise: 5_500_000, repairAllowancePaise: 100_000 });
    missionId = built!.mission.id;
    const affected = built!.selections.find((selection) => /monitor/i.test(selection.title))!;
    const unaffectedIds = built!.selections.filter((selection) => selection.needId !== affected.needId).map((selection) => selection.id).sort();
    const repaired = await service.replaceFresh(missionId, affected.needId, built!.mission.version);
    const selected = repaired!.selections.filter((selection) => selection.status === "SELECTED");
    expect(selected.find((selection) => selection.needId === affected.needId)?.externalId).toContain("fresh-replacement");
    expect(selected.filter((selection) => selection.needId !== affected.needId).map((selection) => selection.id).sort()).toEqual(unaffectedIds);
    for (const [query, count] of calls) expect(count).toBe(/144Hz monitor/i.test(query) ? 3 : 2);
  });

  it("keeps the optimization header authority and payment amount synchronized to the selected portfolio", async () => {
    vi.stubEnv("MISSIONPAY_PLANNER_PROVIDER", "mock");
    vi.stubEnv("MISSIONPAY_MARKET_MODE", "sandbox");
    const service = new ContinuityService(db);
    const built = await service.build({ goal: "Build the best gaming setup under ₹55,000 with a 144Hz monitor, mechanical keyboard, wireless mouse and ergonomic chair", maximumAuthorityPaise: 5_500_000, repairAllowancePaise: 100_000 });
    missionId = built!.mission.id;

    const selected = await service.selectPortfolio(missionId, "MAX_PERFORMANCE", built!.mission.version);
    const authoritativePortfolio = selected!.decision!.portfolios.find((portfolio) => portfolio.type === selected!.decision!.selectedPortfolio)!;
    expect(selected!.decision).toMatchObject({ selectedPortfolio: "MAX_PERFORMANCE", requiresRevalidation: true });
    expect(selected!.mission.reservedPaise).toBe(authoritativePortfolio.totalPricePaise);
    expect(selected!.mission.version).toBe(built!.mission.version + 1);

    const provider = new RepairPaymentProvider();
    const payments = new MissionPaymentService(provider, db);
    await expect(payments.createOrder({ missionId, expectedVersion: selected!.mission.version, requestKey: `before-revalidation-${randomUUID()}` })).rejects.toMatchObject({ code: "PAYMENT_NOT_ALLOWED" });

    const revalidated = await service.revalidate(missionId, selected!.mission.version);
    expect(revalidated!.decision).toMatchObject({ selectedPortfolio: "MAX_PERFORMANCE", requiresRevalidation: false });
    expect(revalidated!.mission.reservedPaise).toBe(authoritativePortfolio.totalPricePaise);
    const order = await payments.createOrder({ missionId, expectedVersion: revalidated!.mission.version, requestKey: `after-revalidation-${randomUUID()}` });
    expect(order.amount).toBe(authoritativePortfolio.totalPricePaise);
  });

  it("captures a separate repair payment exactly once without changing original committed authority", async () => {
    vi.stubEnv("MISSIONPAY_PLANNER_PROVIDER", "mock");
    vi.stubEnv("MISSIONPAY_MARKET_MODE", "sandbox");
    const service = new ContinuityService(db);
    const built = await service.build({ goal: "Buy event essentials under ₹20,000 with projector and wireless microphone", maximumAuthorityPaise: 2_000_000, repairAllowancePaise: 100_000 });
    missionId = built!.mission.id;
    const captured = built!.mission.reservedPaise;
    const [originalOrder] = await db.insert(missionPaymentOrders).values({ missionId, missionVersion: built!.mission.version, amount: captured, currency: "INR", provider: "razorpay", providerOrderId: `original_${missionId}`, status: "CAPTURED" }).returning();
    await db.update(missions).set({ status: "PAID", reservedAmount: 0, committedAmount: captured }).where(eq(missions.id, missionId));
    const degraded = await service.reportIssue(missionId, built!.selections[0].needId, "Item unavailable");
    expect(degraded!.outcomeStatus).toBe("DEGRADED");
    expect(degraded!.mission.committedPaise).toBe(captured);
    const repair = await service.replaceFresh(missionId, built!.selections[0].needId, degraded!.mission.version);
    expect(repair!.outcomeStatus).toBe("REPAIR_AUTHORIZED");
    expect(repair!.mission.committedPaise).toBe(captured);
    expect(repair!.mission.reservedPaise).toBe(0);
    expect(repair!.repairs[0]).toMatchObject({ originalPaymentOrderId: originalOrder.id, additionalSpendPaise: 45_000, authorizedAdditionalSpendPaise: 45_000, status: "REPAIR_AUTHORIZED" });

    const provider = new RepairPaymentProvider();
    const payments = new ContinuityRepairPaymentService(provider, db);
    const order = await payments.createOrder({ missionId, repairAttemptId: repair!.repairs[0].id, expectedVersion: repair!.mission.version, requestKey: "repair-smoke" });
    const paymentId = `repair_payment_${randomUUID()}`;
    provider.payments.set(paymentId, { providerPaymentId: paymentId, providerOrderId: order.providerOrderId!, status: "captured", amount: 45_000, currency: "INR" });
    const firstCapture = await payments.processCheckoutCallback({ paymentId, orderId: order.providerOrderId!, signature: "valid" });
    const duplicateCapture = await payments.processWebhookCapture(provider.payments.get(paymentId)!, "repair-webhook-duplicate");
    expect(firstCapture).toMatchObject({ status: "REPAIR_PAYMENT_CAPTURED", duplicate: false, amount: 45_000 });
    expect(duplicateCapture).toMatchObject({ status: "REPAIR_PAYMENT_CAPTURED", duplicate: true, amount: 45_000 });
    const [savedMission] = await db.select().from(missions).where(eq(missions.id, missionId));
    expect(savedMission.committedAmount).toBe(captured);
    const [savedOrder] = await db.select().from(continuityRepairPaymentOrders).where(eq(continuityRepairPaymentOrders.missionId, missionId));
    const attempts = await db.select().from(continuityRepairPaymentAttempts).where(eq(continuityRepairPaymentAttempts.missionId, missionId));
    const [savedRepair] = await db.select().from(continuityRepairAttempts).where(eq(continuityRepairAttempts.missionId, missionId));
    expect(savedOrder).toMatchObject({ status: "CAPTURED", amount: 45_000 });
    expect(savedRepair.status).toBe("REPAIR_PAYMENT_CAPTURED");
    expect(attempts).toHaveLength(1);
  });

  it("requires explicit human authority before a repair payment exceeding the allowance", async () => {
    vi.stubEnv("MISSIONPAY_PLANNER_PROVIDER", "mock");
    vi.stubEnv("MISSIONPAY_MARKET_MODE", "sandbox");
    const service = new ContinuityService(db);
    const built = await service.build({ goal: "Buy a monitor under ₹10,000", maximumAuthorityPaise: 1_000_000, repairAllowancePaise: 10_000 });
    missionId = built!.mission.id;
    const captured = built!.mission.reservedPaise;
    await db.insert(missionPaymentOrders).values({ missionId, missionVersion: built!.mission.version, amount: captured, providerOrderId: `original_${missionId}`, status: "CAPTURED" });
    await db.update(missions).set({ status: "PAID", reservedAmount: 0, committedAmount: captured }).where(eq(missions.id, missionId));
    const degraded = await service.reportIssue(missionId, built!.selections[0].needId, "Unavailable");
    const repair = await service.replaceFresh(missionId, built!.selections[0].needId, degraded!.mission.version);
    expect(repair!.outcomeStatus).toBe("HUMAN_REAUTH_REQUIRED");
    expect(repair!.repairs[0]).toMatchObject({ additionalSpendPaise: 45_000, authorizedAdditionalSpendPaise: 10_000 });
    const payments = new ContinuityRepairPaymentService(new RepairPaymentProvider(), db);
    await expect(payments.createOrder({ missionId, repairAttemptId: repair!.repairs[0].id, expectedVersion: repair!.mission.version })).rejects.toMatchObject({ code: "PAYMENT_NOT_ALLOWED" });
    const authorization = await payments.authorizeAdditional({ missionId, repairAttemptId: repair!.repairs[0].id, expectedVersion: repair!.mission.version });
    expect(authorization).toMatchObject({ additionalAuthorizationPaise: 35_000, amount: 45_000, status: "REPAIR_AUTHORIZED" });
    const order = await payments.createOrder({ missionId, repairAttemptId: repair!.repairs[0].id, expectedVersion: authorization.missionVersion });
    expect(order.amount).toBe(45_000);
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
