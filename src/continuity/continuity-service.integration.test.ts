import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db, sqlClient } from "@/db/client";
import { continuityMissions, continuityRepairAttempts, continuityRepairPaymentAttempts, continuityRepairPaymentOrders, marketOfferSnapshots, missionOutcomeEvents, missionPaymentOrders, missions } from "@/db/schema";
import { ContinuityRepairPaymentService } from "@/payments/continuity-repair-payment-service";
import { MissionPaymentService } from "@/payments/mission-payment-service";
import { PaymentOrderCoordinator } from "@/payments/payment-order-coordinator";
import type { PaymentProvider, ProviderPayment } from "@/payments/payment-provider";
import { ContinuityService } from "./continuity-service";
import { EvidenceDecisionEngine, EvidenceSearchConnector } from "./evidence-engine";
import { MarketGateway, SerpApiShoppingConnector } from "./market-gateway";
import { MissionCompiler } from "./mission-compiler";
import { ContinuityError } from "./types";

let missionId: string | undefined;
async function buildMission(service: ContinuityService, input: Parameters<ContinuityService["understand"]>[0]) {
  const understood = await service.understand(input);
  missionId = understood.missionId;
  return service.build({ missionId: understood.missionId, missionVersion: understood.missionVersion });
}
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
  it("compiles once, persists the rooftop MissionSpec, and searches its atomic product needs through Shopping", async () => {
    vi.stubEnv("MISSIONPAY_PLANNER_PROVIDER", "groq");
    vi.stubEnv("GROQ_API_KEY", "test-groq-key");
    vi.stubEnv("MISSIONPAY_PLANNER_MODEL", "openai/gpt-oss-120b");
    const goal = "I have 24 hours to turn an empty rooftop into a premium outdoor movie night for 20 people under ₹1,00,000. Build the complete setup with a projector, projection screen, powerful audio, reliable backup power, ambient lighting and all required connectivity.";
    const needInputs = [
      ["projector", "Outdoor projector", "projector"],
      ["screen", "Projection screen", "projection screen"],
      ["audio", "Powerful outdoor audio", "powerful audio"],
      ["power", "Reliable backup power", "reliable backup power"],
      ["lighting", "Ambient outdoor lighting", "ambient lighting"],
      ["connectivity", "Compatible connectivity", "all required connectivity"],
    ] as const;
    const compiledSpec = {
      goal, budgetPaise: 10_000_000, currency: "INR", deadline: null, deadlineText: "within 24 hours", optimizationIntent: "BEST_VALUE",
      participants: [{ label: "guests", count: 20, role: "participant" }], preferences: [],
      needs: needInputs.map(([id, label, sourcePhrase]) => ({
        id, label, kind: "PRODUCT", quantity: 1, required: true,
        grounding: { explicit: true, inferred: false, sourcePhrase, inferenceClass: "EXPLICIT" },
        rationale: "Directly requested by the user.", constraints: [], searchQueries: [`${label} India`], requiredAttributes: [], dependencies: [],
      })),
      globalConstraints: [{ id: "budget", description: "Stay within authorized budget", type: "BUDGET", value: "10000000", hard: true, sourcePhrase: null }],
      outcome: { requiredNeedIds: needInputs.map(([id]) => id), predicates: [] },
      repairAuthority: { allowAutomaticSubstitution: true, maxAdditionalSpendPaise: 0 },
    };
    const compilerFetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ output_text: JSON.stringify(compiledSpec) }), { status: 200 }));
    const compiler = new MissionCompiler(compilerFetcher as typeof fetch, { info: vi.fn() });
    const shoppingFetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      const query = url.searchParams.get("q") ?? "product";
      const title = /backup power/i.test(query) ? `${query} 1200VA` : query;
      return new Response(JSON.stringify({ shopping_results: [{ product_id: query, title, source: "Test Shopping Merchant", extracted_price: 1000, product_link: `https://example.test/${encodeURIComponent(query)}` }] }), { status: 200 });
    });
    const gateway = new MarketGateway("live", [new SerpApiShoppingConnector("test-serpapi-key", shoppingFetcher as typeof fetch)]);
    const gatewaySearch = vi.spyOn(gateway, "search");
    const evidenceFetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ organic_results: [] }), { status: 200 }));
    const decisionEngine = new EvidenceDecisionEngine(new EvidenceSearchConnector("test-serpapi-key", evidenceFetcher as typeof fetch));
    const service = new ContinuityService(db, compiler, decisionEngine, () => gateway);

    const understood = await service.understand({ goal, maximumAuthorityPaise: 10_000_000 });
    missionId = understood.missionId;
    expect(compilerFetcher).toHaveBeenCalledTimes(1);
    expect(understood.spec.needs.map((need) => need.label)).toContain("Outdoor projector");
    expect(understood.spec.needs.map((need) => need.label)).toContain("Projection screen");

    const [persisted] = await db.select().from(continuityMissions).where(eq(continuityMissions.missionId, missionId));
    const built = await service.build({ missionId, missionVersion: understood.missionVersion });
    expect(compilerFetcher).toHaveBeenCalledTimes(1);
    expect(gatewaySearch).toHaveBeenCalledTimes(1);
    expect(gatewaySearch.mock.calls[0][0]).toEqual(understood.spec.needs);
    expect((persisted.spec as { needs: unknown[] }).needs).toEqual(understood.spec.needs);
    expect(shoppingFetcher).toHaveBeenCalledTimes(understood.spec.needs.length);
    expect(shoppingFetcher.mock.calls.every(([input]) => new URL(String(input)).searchParams.get("engine") === "google_shopping")).toBe(true);
    expect(built?.spec.needs).toEqual(understood.spec.needs);
  });

  it("never surfaces a compiler-stage error from market search", async () => {
    vi.stubEnv("MISSIONPAY_PLANNER_PROVIDER", "mock");
    const compiler = new MissionCompiler();
    const compilerCall = vi.spyOn(compiler, "compile");
    const gateway = new MarketGateway("sandbox");
    vi.spyOn(gateway, "search").mockRejectedValue(new ContinuityError("MISSION_COMPILER_UNAVAILABLE", "stale compiler error", 503));
    const service = new ContinuityService(db, compiler, new EvidenceDecisionEngine(), () => gateway);
    const understood = await service.understand({ goal: "Buy a monitor under ₹20,000", maximumAuthorityPaise: 2_000_000 });
    missionId = understood.missionId;
    await expect(service.build({ missionId, missionVersion: understood.missionVersion })).rejects.toMatchObject({ code: "MARKET_SEARCH_FAILED" });
    expect(compilerCall).toHaveBeenCalledTimes(1);
  });

  it("compiles an arbitrary mission, reserves bounded authority, minimally replaces, and revalidates", async () => {
    vi.stubEnv("MISSIONPAY_PLANNER_PROVIDER", "mock");
    vi.stubEnv("MISSIONPAY_MARKET_MODE", "sandbox");
    const service = new ContinuityService(db);
    const built = await buildMission(service, { goal: "Build a gaming setup under ₹55,000 with a 144Hz monitor, mechanical keyboard, wireless mouse and ergonomic chair", maximumAuthorityPaise: 5_500_000, repairAllowancePaise: 100_000, location: { manualLabel: "Varanasi, Uttar Pradesh" } });
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
    const built = await buildMission(service, { goal: "Build a gaming setup under ₹55,000 with a 144Hz monitor, mechanical keyboard, wireless mouse and ergonomic chair", maximumAuthorityPaise: 5_500_000, repairAllowancePaise: 100_000 });
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
    const built = await buildMission(service, { goal: "Build the best gaming setup under ₹55,000 with a 144Hz monitor, mechanical keyboard, wireless mouse and ergonomic chair", maximumAuthorityPaise: 5_500_000, repairAllowancePaise: 100_000 });
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

  it("automatically revalidates expired live offers before creating the Razorpay order", async () => {
    vi.stubEnv("MISSIONPAY_PLANNER_PROVIDER", "mock");
    vi.stubEnv("MISSIONPAY_MARKET_MODE", "sandbox");
    vi.stubEnv("SERPAPI_API_KEY", "test-only-key");
    vi.stubEnv("MISSIONPAY_MARKET_FRESHNESS_SECONDS", "180");
    const service = new ContinuityService(db);
    const built = await buildMission(service, { goal: "Build the best gaming setup under ₹55,000 with a 144Hz monitor, mechanical keyboard, wireless mouse and ergonomic chair", maximumAuthorityPaise: 5_500_000, repairAllowancePaise: 100_000 });
    missionId = built!.mission.id;
    const active = built!.selections.filter((selection) => selection.status === "SELECTED");
    await db.update(continuityMissions).set({ marketMode: "live" }).where(eq(continuityMissions.missionId, missionId));
    await db.update(marketOfferSnapshots).set({ sourceProvider: "serpapi-google-shopping", observedAt: new Date(0) }).where(eq(marketOfferSnapshots.missionId, missionId));
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ shopping_results: active.map((selection) => ({ product_id: selection.externalId, title: selection.title, source: selection.merchantName, extracted_price: selection.pricePaise / 100, product_link: selection.sourceUrl })) }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const provider = new RepairPaymentProvider();
    const coordinator = new PaymentOrderCoordinator(new MissionPaymentService(provider, db), service);
    const order = await coordinator.createOrder({ missionId, expectedVersion: built!.mission.version, requestKey: `automatic-revalidation-${randomUUID()}` });
    expect(order).toMatchObject({ marketRevalidated: true, amount: built!.mission.reservedPaise });
    expect(provider.calls).toBe(1);
  });

  it("blocks Razorpay and degrades the affected component when an expired live price changed", async () => {
    vi.stubEnv("MISSIONPAY_PLANNER_PROVIDER", "mock");
    vi.stubEnv("MISSIONPAY_MARKET_MODE", "sandbox");
    vi.stubEnv("SERPAPI_API_KEY", "test-only-key");
    vi.stubEnv("MISSIONPAY_MARKET_FRESHNESS_SECONDS", "180");
    const service = new ContinuityService(db);
    const built = await buildMission(service, { goal: "Build the best gaming setup under ₹55,000 with a 144Hz monitor, mechanical keyboard, wireless mouse and ergonomic chair", maximumAuthorityPaise: 5_500_000, repairAllowancePaise: 100_000 });
    missionId = built!.mission.id;
    const active = built!.selections.filter((selection) => selection.status === "SELECTED");
    const changedId = active[0].externalId;
    await db.update(continuityMissions).set({ marketMode: "live" }).where(eq(continuityMissions.missionId, missionId));
    await db.update(marketOfferSnapshots).set({ sourceProvider: "serpapi-google-shopping", observedAt: new Date(0) }).where(eq(marketOfferSnapshots.missionId, missionId));
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ shopping_results: active.map((selection) => ({ product_id: selection.externalId, title: selection.title, source: selection.merchantName, extracted_price: selection.pricePaise / 100 + (selection.externalId === changedId ? 1 : 0), product_link: selection.sourceUrl })) }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const provider = new RepairPaymentProvider();
    const coordinator = new PaymentOrderCoordinator(new MissionPaymentService(provider, db), service);
    await expect(coordinator.createOrder({ missionId, expectedVersion: built!.mission.version, requestKey: `market-change-${randomUUID()}` })).rejects.toMatchObject({ code: "MARKET_CHANGED" });
    expect(provider.calls).toBe(0);
    const changed = await service.get(missionId);
    expect(changed!.outcomeStatus).toBe("DEGRADED");
    expect(changed!.selections.find((selection) => selection.externalId === changedId)?.status).toBe("DEGRADED");
    expect(await db.select().from(missionPaymentOrders).where(eq(missionPaymentOrders.missionId, missionId))).toHaveLength(0);
  });

  it("captures a separate repair payment exactly once without changing original committed authority", async () => {
    vi.stubEnv("MISSIONPAY_PLANNER_PROVIDER", "mock");
    vi.stubEnv("MISSIONPAY_MARKET_MODE", "sandbox");
    const service = new ContinuityService(db);
    const built = await buildMission(service, { goal: "Buy event essentials under ₹20,000 with projector and wireless microphone", maximumAuthorityPaise: 2_000_000, repairAllowancePaise: 100_000 });
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
    const built = await buildMission(service, { goal: "Buy a monitor under ₹10,000", maximumAuthorityPaise: 1_000_000, repairAllowancePaise: 10_000 });
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
    const built = await buildMission(service, { goal: "Buy a display under ₹10,000", maximumAuthorityPaise: 1_000_000 });
    missionId = built!.mission.id;
    await db.insert(missionOutcomeEvents).values({ missionId, type: "SMOKE_EVENT", data: { source: "test" } });
    await expect(db.update(missionOutcomeEvents).set({ type: "MUTATED" }).where(eq(missionOutcomeEvents.missionId, missionId))).rejects.toThrow();
    await expect(db.delete(missionOutcomeEvents).where(eq(missionOutcomeEvents.missionId, missionId))).rejects.toThrow();
    const persisted = await db.select().from(missionOutcomeEvents).where(eq(missionOutcomeEvents.missionId, missionId));
    expect(persisted).toHaveLength(1);
    expect(persisted[0].type).toBe("SMOKE_EVENT");
  });
});
