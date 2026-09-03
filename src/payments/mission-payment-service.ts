import { and, desc, eq } from "drizzle-orm";
import { db, type Database } from "@/db/client";
import { assertTransition } from "@/domain/mission-state";
import { MissionError } from "@/domain/errors";
import { merchants, missionEvents, missionItems, missionPaymentOrders, missions, offers, paymentAttempts, reservations } from "@/db/schema";
import { PaymentError } from "./payment-errors";
import type { PaymentProvider, ProviderPayment } from "./payment-provider";

type PaymentOrderInput = { missionId: string; expectedVersion: number; requestKey?: string };
type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type PayableRow = {
  required: boolean; reservationId: string | null; reservationStatus: "ACTIVE" | "RELEASED" | "INVALID" | "COMMITTED" | "EXPIRED" | null;
  reservedAmount: number | null; offerAmount: number | null; offerVersion: number | null; reservedOfferVersion: number | null;
  offerReadyAt: Date | null; reservedReadyAt: Date | null; offerAvailable: boolean | null; reservedAvailable: boolean | null;
  offerVegetarian: boolean | null; reservedVegetarian: boolean | null; offerServesPeople: number | null; reservedServesPeople: number | null;
  category: "CAKE" | "FLOWERS" | "RESTAURANT" | null;
};

function assertIntegerAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new PaymentError("PAYMENT_AMOUNT_MISMATCH", "Payment amount is not a valid integer-paise value");
}

export class MissionPaymentService {
  constructor(private readonly provider: PaymentProvider, private readonly database: Database = db) {}

  async createOrder(input: PaymentOrderInput) {
    return this.database.transaction(async (transaction) => {
      const [mission] = await transaction.select().from(missions).where(eq(missions.id, input.missionId)).for("update");
      if (!mission) throw new MissionError("MISSION_NOT_FOUND", "Mission not found", 404);
      const existingOrders = await transaction.select().from(missionPaymentOrders).where(eq(missionPaymentOrders.missionId, mission.id)).orderBy(desc(missionPaymentOrders.createdAt));
      const existing = existingOrders.find((candidate) => candidate.missionVersion === input.expectedVersion) ?? existingOrders[0];
      if (mission.version !== input.expectedVersion) {
        if (existing?.missionVersion === input.expectedVersion && existing.status === "ACTIVE" && existing.providerOrderId) return this.publicOrder(existing);
        throw new PaymentError("PAYMENT_STALE_MISSION", "Mission version does not match", 409, { expectedVersion: input.expectedVersion, currentVersion: mission.version });
      }
      if (existing?.status === "ACTIVE" && existing.providerOrderId) return this.publicOrder(existing);
      if (existing?.status === "CAPTURED") return this.publicOrder(existing);
      if (mission.status !== "READY_TO_COMMIT") throw new PaymentError("PAYMENT_NOT_ALLOWED", `Mission must be READY_TO_COMMIT, not ${mission.status}`);

      const authority = await this.authoritativePaymentAmount(transaction, mission);
      assertIntegerAmount(authority);
      if (existing) throw new PaymentError("PAYMENT_FAILED", "A payment order is already being reconciled for this mission version", 409);
      if (!this.provider.publicKeyId) throw new PaymentError("PAYMENT_NOT_CONFIGURED", "Razorpay test-mode public key is not configured", 503);

      const [paymentOrder] = await transaction.insert(missionPaymentOrders).values({ missionId: mission.id, missionVersion: mission.version, amount: authority, currency: "INR", provider: this.provider.provider, idempotencyKey: input.requestKey ?? null, status: "ACTIVE" }).returning();
      await transaction.insert(missionEvents).values({ missionId: mission.id, type: "MISSION_PAYMENT_ORDER_REQUESTED", missionVersion: mission.version, data: { paymentOrderId: paymentOrder.id, amount: authority, currency: "INR" } });
      const providerOrder = await this.provider.createOrder({ amount: authority, currency: "INR", receipt: `mission_${mission.id.slice(0, 24)}`, notes: { mission_id: mission.id, mission_version: String(mission.version), missionpay_payment_order_id: paymentOrder.id } });
      if (providerOrder.amount !== authority || providerOrder.currency !== "INR") throw new PaymentError("PAYMENT_PROVIDER_MISMATCH", "Provider order does not match authoritative mission amount", 502);
      const pendingVersion = mission.version + 1;
      assertTransition(mission.status, "PAYMENT_PENDING");
      await transaction.update(missionPaymentOrders).set({ providerOrderId: providerOrder.providerOrderId, updatedAt: new Date() }).where(eq(missionPaymentOrders.id, paymentOrder.id));
      await transaction.update(missions).set({ status: "PAYMENT_PENDING", version: pendingVersion, updatedAt: new Date() }).where(eq(missions.id, mission.id));
      await transaction.insert(missionEvents).values([
        { missionId: mission.id, type: "RAZORPAY_ORDER_CREATED", missionVersion: pendingVersion, data: { paymentOrderId: paymentOrder.id, providerOrderId: providerOrder.providerOrderId, amount: authority } },
        { missionId: mission.id, type: "MISSION_PAYMENT_PENDING", missionVersion: pendingVersion, data: { paymentOrderId: paymentOrder.id } },
      ]);
      return this.publicOrder({ ...paymentOrder, providerOrderId: providerOrder.providerOrderId });
    });
  }

  async processCheckoutCallback(input: { paymentId: string; orderId: string; signature: string }) {
    const [order] = await this.database.select().from(missionPaymentOrders).where(eq(missionPaymentOrders.providerOrderId, input.orderId));
    if (!order) throw new PaymentError("PAYMENT_ORDER_NOT_FOUND", "Payment order is not known to MissionPay", 404);
    if (!this.provider.verifyCheckoutSignature({ expectedOrderId: order.providerOrderId!, paymentId: input.paymentId, signature: input.signature })) {
      await this.recordRejectedCallback(order.missionId, order.id, input.paymentId, "PAYMENT_SIGNATURE_INVALID", order.missionVersion);
      throw new PaymentError("PAYMENT_SIGNATURE_INVALID", "Checkout signature is invalid", 400);
    }
    await this.recordCallbackEvent(order.missionId, order.id, input.paymentId, input.orderId, order.missionVersion);
    const payment = await this.provider.fetchPayment(input.paymentId);
    if (payment.providerOrderId !== order.providerOrderId || payment.amount !== order.amount || payment.currency !== order.currency) throw new PaymentError("PAYMENT_PROVIDER_MISMATCH", "Payment does not match the persisted MissionPay order");
    if (payment.status !== "captured") throw new PaymentError("PAYMENT_NOT_CAPTURED", "Payment is authentic but not captured yet", 409);
    return this.finalizeCaptured(order.id, payment, true);
  }

  async processWebhookCapture(payment: ProviderPayment, eventId: string) {
    const [order] = await this.database.select().from(missionPaymentOrders).where(eq(missionPaymentOrders.providerOrderId, payment.providerOrderId));
    if (!order) throw new PaymentError("PAYMENT_ORDER_NOT_FOUND", "Webhook order is not known to MissionPay", 404);
    if (payment.amount !== order.amount || payment.currency !== order.currency) throw new PaymentError("PAYMENT_AMOUNT_MISMATCH", "Webhook payment amount does not match the persisted order");
    return this.finalizeCaptured(order.id, payment, false, eventId);
  }

  async processWebhookFailure(payment: Pick<ProviderPayment, "providerPaymentId" | "providerOrderId" | "status" | "amount" | "currency">, eventId: string) {
    const [order] = await this.database.select().from(missionPaymentOrders).where(eq(missionPaymentOrders.providerOrderId, payment.providerOrderId));
    if (!order) return { ignored: true };
    return this.database.transaction(async (transaction) => {
      const [locked] = await transaction.select().from(missionPaymentOrders).where(eq(missionPaymentOrders.id, order.id)).for("update");
      if (!locked || locked.status === "CAPTURED") return { ignored: true };
      await transaction.update(missionPaymentOrders).set({ status: "FAILED", updatedAt: new Date() }).where(eq(missionPaymentOrders.id, locked.id));
      const [mission] = await transaction.select().from(missions).where(eq(missions.id, locked.missionId)).for("update");
      if (mission && mission.status === "PAYMENT_PENDING") {
        const nextVersion = mission.version + 1;
        assertTransition(mission.status, "PAYMENT_FAILED");
        await transaction.update(missions).set({ status: "PAYMENT_FAILED", version: nextVersion, updatedAt: new Date() }).where(eq(missions.id, mission.id));
        await transaction.insert(missionEvents).values({ missionId: mission.id, type: "PAYMENT_FAILED", missionVersion: nextVersion, data: { paymentOrderId: locked.id, providerPaymentId: payment.providerPaymentId, eventId } });
      }
      return { ignored: false };
    });
  }

  async getLatest(missionId: string) {
    const [order] = await this.database.select().from(missionPaymentOrders).where(eq(missionPaymentOrders.missionId, missionId)).orderBy(desc(missionPaymentOrders.createdAt)).limit(1);
    const [attempt] = await this.database.select().from(paymentAttempts).where(eq(paymentAttempts.missionId, missionId)).orderBy(desc(paymentAttempts.createdAt)).limit(1);
    return { order: order ?? null, attempt: attempt ?? null };
  }

  private async authoritativePaymentAmount(transaction: DbTransaction, mission: typeof missions.$inferSelect): Promise<number> {
    if (mission.committedAmount !== 0 || mission.reservedAmount <= 0 || mission.reservedAmount > mission.budgetAmount) throw new PaymentError("PAYMENT_NOT_ALLOWED", "Mission has no legally payable authority");
    const rows = await transaction.select({ itemId: missionItems.id, required: missionItems.required, reservationId: missionItems.reservationId, reservationStatus: reservations.status, reservedAmount: reservations.amount, offerAmount: offers.amount, offerVersion: offers.version, reservedOfferVersion: reservations.offerVersion, offerReadyAt: offers.readyAt, reservedReadyAt: reservations.readyAt, offerAvailable: offers.available, reservedAvailable: reservations.offerAvailable, offerVegetarian: offers.vegetarian, reservedVegetarian: reservations.offerVegetarian, offerServesPeople: offers.servesPeople, reservedServesPeople: reservations.offerServesPeople, category: merchants.category }).from(missionItems).leftJoin(reservations, eq(missionItems.reservationId, reservations.id)).leftJoin(offers, eq(reservations.offerId, offers.id)).leftJoin(merchants, eq(offers.merchantId, merchants.id)).where(eq(missionItems.missionId, mission.id));
    const required = (rows as PayableRow[]).filter((row) => row.required);
    if (required.some((row) => !row.reservationId || row.reservationStatus !== "ACTIVE" || row.offerAvailable !== true || row.offerVersion !== row.reservedOfferVersion || row.offerAmount !== row.reservedAmount || !row.offerReadyAt || row.offerReadyAt > mission.deadline || row.offerReadyAt.getTime() !== row.reservedReadyAt?.getTime() || row.offerVegetarian !== row.reservedVegetarian || row.offerServesPeople !== row.reservedServesPeople)) throw new PaymentError("PAYMENT_NOT_ALLOWED", "Mission terms are no longer valid for payment");
    const restaurant = required.find((row) => row.category === "RESTAURANT");
    const constraints = mission.constraints as { vegetarian?: boolean; people?: number };
    if (constraints.vegetarian && restaurant?.offerVegetarian !== true) throw new PaymentError("PAYMENT_NOT_ALLOWED", "Vegetarian constraint is not satisfied");
    if (constraints.people && (restaurant?.offerServesPeople ?? 0) < constraints.people) throw new PaymentError("PAYMENT_NOT_ALLOWED", "Capacity constraint is not satisfied");
    const sum = required.reduce((total, row) => total + (row.reservedAmount ?? 0), 0);
    if (sum !== mission.reservedAmount) throw new PaymentError("PAYMENT_NOT_ALLOWED", "Persisted reservation total does not match mission authority");
    return sum;
  }

  private publicOrder(order: { id: string; providerOrderId: string | null; amount: number; currency: string }) {
    return { paymentOrderId: order.id, providerOrderId: order.providerOrderId, amount: order.amount, currency: order.currency, publicKeyId: this.provider.publicKeyId };
  }

  private async recordCallbackEvent(missionId: string, paymentOrderId: string, paymentId: string, orderId: string, missionVersion: number) {
    await this.database.insert(missionEvents).values({ missionId, type: "CHECKOUT_CALLBACK_RECEIVED", missionVersion, data: { paymentOrderId, providerPaymentId: paymentId, providerOrderId: orderId } });
    await this.database.insert(missionEvents).values({ missionId, type: "CHECKOUT_SIGNATURE_VERIFIED", missionVersion, data: { paymentOrderId, providerPaymentId: paymentId } });
  }

  private async recordRejectedCallback(missionId: string, paymentOrderId: string, paymentId: string, code: string, missionVersion: number) {
    await this.database.insert(missionEvents).values({ missionId, type: "CHECKOUT_SIGNATURE_REJECTED", missionVersion, data: { paymentOrderId, providerPaymentId: paymentId, code } });
  }

  private async finalizeCaptured(orderId: string, payment: ProviderPayment, callbackVerified: boolean, eventId?: string) {
    return this.database.transaction(async (transaction) => {
      const [order] = await transaction.select().from(missionPaymentOrders).where(eq(missionPaymentOrders.id, orderId)).for("update");
      if (!order) throw new PaymentError("PAYMENT_ORDER_NOT_FOUND", "Payment order not found", 404);
      if (order.status === "CAPTURED") return { status: "PAID", duplicate: true, amount: order.amount, paymentId: payment.providerPaymentId };
      if (order.providerOrderId !== payment.providerOrderId || order.amount !== payment.amount || order.currency !== payment.currency) throw new PaymentError("PAYMENT_PROVIDER_MISMATCH", "Captured payment does not match persisted order");
      const [mission] = await transaction.select().from(missions).where(eq(missions.id, order.missionId)).for("update");
      if (!mission) throw new MissionError("MISSION_NOT_FOUND", "Mission not found", 404);
      if (mission.status !== "PAYMENT_PENDING") throw new PaymentError("PAYMENT_NOT_ALLOWED", `Mission is not awaiting payment (${mission.status})`);
      const nextVersion = mission.version + 1;
      await transaction.insert(paymentAttempts).values({ missionId: mission.id, missionPaymentOrderId: order.id, providerPaymentId: payment.providerPaymentId, providerOrderId: payment.providerOrderId, callbackVerified, providerStatus: payment.status, amount: payment.amount, status: "CAPTURED" }).onConflictDoUpdate({ target: paymentAttempts.providerPaymentId, set: { callbackVerified: true, providerStatus: payment.status, status: "CAPTURED", updatedAt: new Date() } });
      const activeReservations = await transaction
        .select({ id: reservations.id, version: reservations.version })
        .from(reservations)
        .where(and(eq(reservations.missionId, mission.id), eq(reservations.status, "ACTIVE")))
        .for("update");
      for (const reservation of activeReservations) {
        await transaction.update(reservations).set({ status: "COMMITTED", version: reservation.version + 1, updatedAt: new Date() }).where(eq(reservations.id, reservation.id));
      }
      await transaction.update(missions).set({ status: "PAID", reservedAmount: 0, committedAmount: mission.committedAmount + order.amount, version: nextVersion, updatedAt: new Date() }).where(eq(missions.id, mission.id));
      await transaction.update(missionPaymentOrders).set({ status: "CAPTURED", updatedAt: new Date() }).where(eq(missionPaymentOrders.id, order.id));
      await transaction.insert(missionEvents).values([
        { missionId: mission.id, type: "PAYMENT_CAPTURED", missionVersion: nextVersion, data: { paymentOrderId: order.id, providerPaymentId: payment.providerPaymentId, providerOrderId: payment.providerOrderId, amount: order.amount, eventId } },
        { missionId: mission.id, type: "MISSION_PAYMENT_FINALIZED", missionVersion: nextVersion, data: { paymentOrderId: order.id, amount: order.amount, committedAmount: mission.committedAmount + order.amount } },
      ]);
      return { status: "PAID", duplicate: false, amount: order.amount, paymentId: payment.providerPaymentId };
    });
  }
}
