import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db, sqlClient } from "@/db/client";
import { merchants, missionItems, missionPaymentOrders, missions, offers, reservations } from "@/db/schema";
import type { PaymentProvider, ProviderPayment } from "./payment-provider";
import { MissionPaymentService } from "./mission-payment-service";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for PostgreSQL integration tests");

class MockProvider implements PaymentProvider {
  readonly provider = "razorpay";
  readonly publicKeyId = "rzp_test_mock";
  calls = 0;
  payments = new Map<string, ProviderPayment>();
  async createOrder(input: { amount: number; currency: string; receipt: string; notes: Record<string, string> }) {
    const id = `order_mock_${++this.calls}`;
    return { providerOrderId: id, amount: input.amount, currency: input.currency };
  }
  async fetchPayment(id: string) { return this.payments.get(id) ?? { providerPaymentId: id, providerOrderId: "missing", status: "created", amount: 0, currency: "INR" }; }
  async fetchOrder(id: string) { return { providerOrderId: id, amount: 730000, currency: "INR", status: "created" }; }
  verifyCheckoutSignature(input: { expectedOrderId: string; paymentId: string; signature: string }) { return input.signature === "valid"; }
}

const runId = randomUUID();
const missionIds = new Set<string>();
const offerIds = new Set<string>();
const merchantIds = new Set<string>();
const provider = new MockProvider();
const service = new MissionPaymentService(provider, db);

async function fixture() {
  const [mission] = await db.insert(missions).values({ goal: `Payment integration ${runId}`, budgetAmount: 800000, reservedAmount: 730000, committedAmount: 0, deadline: new Date("2030-01-01T20:00:00+05:30"), status: "READY_TO_COMMIT", version: 14, constraints: { vegetarian: true, people: 2 } }).returning();
  missionIds.add(mission.id);
  const specs = [["CAKE", 125000, true, 1], ["FLOWERS", 85000, true, 1], ["RESTAURANT", 520000, true, 4]] as const;
  for (const [category, amount, vegetarian, servesPeople] of specs) {
    const [merchant] = await db.insert(merchants).values({ name: `IT ${runId} ${category}`, category }).returning();
    merchantIds.add(merchant.id);
    const [offer] = await db.insert(offers).values({ merchantId: merchant.id, name: `Offer ${category}`, amount, readyAt: new Date("2030-01-01T19:00:00+05:30"), vegetarian, servesPeople, available: true, version: 1 }).returning();
    offerIds.add(offer.id);
    const [reservation] = await db.insert(reservations).values({ missionId: mission.id, offerId: offer.id, amount, offerVersion: 1, readyAt: new Date("2030-01-01T19:00:00+05:30"), offerAvailable: true, offerVegetarian: vegetarian, offerServesPeople: servesPeople, status: "ACTIVE", version: 1 }).returning();
    await db.insert(missionItems).values({ missionId: mission.id, category, reservationId: reservation.id, status: "REQUIRED", required: true });
  }
  return mission;
}

async function cleanup() {
  const ids = [...missionIds];
  await sqlClient.begin(async (tx) => {
    await tx.unsafe('ALTER TABLE "mission_events" DISABLE TRIGGER "mission_events_append_only"');
    if (ids.length) {
      await tx`DELETE FROM payment_attempts WHERE mission_id IN ${tx(ids)}`;
      await tx`DELETE FROM mission_payment_orders WHERE mission_id IN ${tx(ids)}`;
      await tx`DELETE FROM mission_items WHERE mission_id IN ${tx(ids)}`;
      await tx`DELETE FROM reservations WHERE mission_id IN ${tx(ids)}`;
      await tx`DELETE FROM mission_events WHERE mission_id IN ${tx(ids)}`;
      await tx`DELETE FROM missions WHERE id IN ${tx(ids)}`;
    }
    await tx.unsafe('ALTER TABLE "mission_events" ENABLE TRIGGER "mission_events_append_only"');
    if (offerIds.size) await tx`DELETE FROM offers WHERE id IN ${tx([...offerIds])}`;
    if (merchantIds.size) await tx`DELETE FROM merchants WHERE id IN ${tx([...merchantIds])}`;
    await tx`DELETE FROM razorpay_webhook_events WHERE event_type = ${`integration-${runId}`}`;
  });
  missionIds.clear(); offerIds.clear(); merchantIds.clear();
}

afterEach(cleanup);
describe("MissionPaymentService live PostgreSQL", () => {
  it("creates one authoritative order and reuses it for concurrent requests", async () => {
    const mission = await fixture();
    const results = await Promise.allSettled([service.createOrder({ missionId: mission.id, expectedVersion: 14, requestKey: "same" }), service.createOrder({ missionId: mission.id, expectedVersion: 14, requestKey: "same" })]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const orders = await db.select().from(missionPaymentOrders).where(eq(missionPaymentOrders.missionId, mission.id));
    expect(orders).toHaveLength(1);
    expect(orders[0].amount).toBe(730000);
  });

  it("rejects stale versions and client amounts are never accepted", async () => {
    const mission = await fixture();
    await expect(service.createOrder({ missionId: mission.id, expectedVersion: 13 })).rejects.toMatchObject({ code: "PAYMENT_STALE_MISSION" });
    const order = await service.createOrder({ missionId: mission.id, expectedVersion: 14 });
    expect(order.amount).toBe(730000);
  });

  it("finalizes captured payment exactly once and commits reservations", async () => {
    const mission = await fixture();
    const order = await service.createOrder({ missionId: mission.id, expectedVersion: 14 });
    provider.payments.set("pay_1", { providerPaymentId: "pay_1", providerOrderId: order.providerOrderId!, status: "captured", amount: 730000, currency: "INR" });
    const first = await service.processCheckoutCallback({ paymentId: "pay_1", orderId: order.providerOrderId!, signature: "valid" });
    const second = await service.processWebhookCapture(provider.payments.get("pay_1")!, `integration-${runId}`);
    expect(first).toMatchObject({ status: "PAID", duplicate: false, amount: 730000 });
    expect(second).toMatchObject({ status: "PAID", duplicate: true });
    const [saved] = await db.select().from(missions).where(eq(missions.id, mission.id));
    expect(saved).toMatchObject({ status: "PAID", budgetAmount: 800000, reservedAmount: 0, committedAmount: 730000 });
    expect(saved.reservedAmount + saved.committedAmount).toBeLessThanOrEqual(saved.budgetAmount);
    const committed = await db.select().from(reservations).where(and(eq(reservations.missionId, mission.id), eq(reservations.status, "COMMITTED")));
    expect(committed).toHaveLength(3);
    expect(committed.every((row) => row.version === 2)).toBe(true);
  });

  it("rejects invalid signatures without payment finalization", async () => {
    const mission = await fixture();
    const order = await service.createOrder({ missionId: mission.id, expectedVersion: 14 });
    await expect(service.processCheckoutCallback({ paymentId: "pay_bad", orderId: order.providerOrderId!, signature: "bad" })).rejects.toMatchObject({ code: "PAYMENT_SIGNATURE_INVALID" });
    const [saved] = await db.select().from(missions).where(eq(missions.id, mission.id));
    expect(saved.status).toBe("PAYMENT_PENDING");
  });

  it("rejects amount mismatch and failed webhook transitions to PAYMENT_FAILED", async () => {
    const mission = await fixture();
    const order = await service.createOrder({ missionId: mission.id, expectedVersion: 14 });
    const wrong = { providerPaymentId: "pay_wrong", providerOrderId: order.providerOrderId!, status: "captured" as const, amount: 729999, currency: "INR" };
    await expect(service.processWebhookCapture(wrong, `integration-${runId}`)).rejects.toMatchObject({ code: "PAYMENT_AMOUNT_MISMATCH" });
    await service.processWebhookFailure({ ...wrong, status: "failed" }, `integration-${runId}-failed`);
    const [saved] = await db.select().from(missions).where(eq(missions.id, mission.id));
    expect(saved.status).toBe("PAYMENT_FAILED");
  });
});
