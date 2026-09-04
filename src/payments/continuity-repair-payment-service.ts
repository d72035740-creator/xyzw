import { and, eq } from "drizzle-orm";
import { db, type Database } from "@/db/client";
import {
  continuityMissions,
  continuityRepairAttempts,
  continuityRepairPaymentAttempts,
  continuityRepairPaymentOrders,
  continuitySelections,
  marketOfferSnapshots,
  missionEvents,
  missionOutcomeEvents,
  missions,
} from "@/db/schema";
import { PaymentError } from "./payment-errors";
import type { PaymentProvider, ProviderPayment } from "./payment-provider";

export class ContinuityRepairPaymentService {
  constructor(private readonly provider: PaymentProvider, private readonly database: Database = db) {}

  async authorizeAdditional(input: { missionId: string; repairAttemptId: string; expectedVersion: number }) {
    return this.database.transaction(async (transaction) => {
      const [mission] = await transaction.select().from(missions).where(eq(missions.id, input.missionId)).for("update");
      if (!mission || mission.status !== "PAID") throw new PaymentError("PAYMENT_NOT_ALLOWED", "Only a paid mission can authorize continuity repair");
      if (mission.version !== input.expectedVersion) throw new PaymentError("PAYMENT_STALE_MISSION", "Mission version does not match", 409, { expectedVersion: input.expectedVersion, currentVersion: mission.version });
      const [repair] = await transaction.select().from(continuityRepairAttempts).where(and(eq(continuityRepairAttempts.id, input.repairAttemptId), eq(continuityRepairAttempts.missionId, input.missionId))).for("update");
      if (!repair) throw new PaymentError("PAYMENT_ORDER_NOT_FOUND", "Continuity repair attempt not found", 404);
      if (repair.status !== "HUMAN_REAUTH_REQUIRED") throw new PaymentError("PAYMENT_NOT_ALLOWED", "This repair does not require human reauthorization");
      const additionalAuthorizationPaise = repair.additionalSpendPaise - repair.authorizedAdditionalSpendPaise;
      if (additionalAuthorizationPaise <= 0) throw new PaymentError("PAYMENT_NOT_ALLOWED", "No additional repair authority is required");
      const version = mission.version + 1;
      await transaction.update(continuityRepairAttempts).set({ authorizedAdditionalSpendPaise: repair.additionalSpendPaise, status: "REPAIR_AUTHORIZED", updatedAt: new Date() }).where(eq(continuityRepairAttempts.id, repair.id));
      await transaction.update(continuityMissions).set({ outcomeStatus: "REPAIR_AUTHORIZED", updatedAt: new Date() }).where(eq(continuityMissions.missionId, mission.id));
      await transaction.update(missions).set({ version, updatedAt: new Date() }).where(eq(missions.id, mission.id));
      await transaction.insert(missionOutcomeEvents).values({ missionId: mission.id, needId: repair.affectedNeedId, type: "HUMAN_REPAIR_AUTHORITY_GRANTED", data: { repairAttemptId: repair.id, additionalAuthorizationPaise, totalRepairPaymentPaise: repair.additionalSpendPaise, source: "USER" } });
      await transaction.insert(missionEvents).values({ missionId: mission.id, type: "CONTINUITY_REPAIR_AUTHORIZED", missionVersion: version, data: { repairAttemptId: repair.id, additionalAuthorizationPaise } });
      return { repairAttemptId: repair.id, status: "REPAIR_AUTHORIZED", additionalAuthorizationPaise, amount: repair.additionalSpendPaise, missionVersion: version };
    });
  }

  async createOrder(input: { missionId: string; repairAttemptId: string; expectedVersion: number; requestKey?: string }) {
    return this.database.transaction(async (transaction) => {
      const [mission] = await transaction.select().from(missions).where(eq(missions.id, input.missionId)).for("update");
      if (!mission || mission.status !== "PAID") throw new PaymentError("PAYMENT_NOT_ALLOWED", "Original mission payment must remain captured");
      if (mission.version !== input.expectedVersion) throw new PaymentError("PAYMENT_STALE_MISSION", "Mission version does not match", 409, { expectedVersion: input.expectedVersion, currentVersion: mission.version });
      const [repair] = await transaction.select().from(continuityRepairAttempts).where(and(eq(continuityRepairAttempts.id, input.repairAttemptId), eq(continuityRepairAttempts.missionId, input.missionId))).for("update");
      if (!repair) throw new PaymentError("PAYMENT_ORDER_NOT_FOUND", "Continuity repair attempt not found", 404);
      const [continuity] = await transaction.select().from(continuityMissions).where(eq(continuityMissions.missionId, mission.id)).for("update");
      const [existing] = await transaction.select().from(continuityRepairPaymentOrders).where(eq(continuityRepairPaymentOrders.repairAttemptId, repair.id)).for("update");
      if (existing?.providerOrderId && ["ACTIVE", "CAPTURED"].includes(existing.status)) return this.publicOrder(existing);
      if (!continuity || continuity.outcomeStatus !== "REPAIR_AUTHORIZED" || repair.status !== "REPAIR_AUTHORIZED" || repair.additionalSpendPaise <= 0 || repair.authorizedAdditionalSpendPaise < repair.additionalSpendPaise) throw new PaymentError("PAYMENT_NOT_ALLOWED", "Repair payment is not fully authorized and revalidated");
      if (!this.provider.publicKeyId) throw new PaymentError("PAYMENT_NOT_CONFIGURED", "Razorpay test-mode public key is not configured", 503);
      const [order] = await transaction.insert(continuityRepairPaymentOrders).values({ missionId: mission.id, repairAttemptId: repair.id, amount: repair.additionalSpendPaise, currency: "INR", provider: this.provider.provider, idempotencyKey: input.requestKey ?? null, status: "ACTIVE" }).returning();
      const providerOrder = await this.provider.createOrder({ amount: order.amount, currency: order.currency, receipt: `repair_${repair.id.slice(0, 24)}`, notes: { mission_id: mission.id, continuity_repair_attempt_id: repair.id, affected_need_id: repair.affectedNeedId, original_payment_order_id: repair.originalPaymentOrderId, replacement_offer_snapshot_id: repair.replacementSnapshotId } });
      if (providerOrder.amount !== order.amount || providerOrder.currency !== order.currency) throw new PaymentError("PAYMENT_PROVIDER_MISMATCH", "Provider order does not match authoritative repair amount", 502);
      const version = mission.version + 1;
      await transaction.update(continuityRepairPaymentOrders).set({ providerOrderId: providerOrder.providerOrderId, updatedAt: new Date() }).where(eq(continuityRepairPaymentOrders.id, order.id));
      await transaction.update(continuityRepairAttempts).set({ status: "REPAIR_PAYMENT_PENDING", updatedAt: new Date() }).where(eq(continuityRepairAttempts.id, repair.id));
      await transaction.update(continuityMissions).set({ outcomeStatus: "REPAIR_PAYMENT_PENDING", updatedAt: new Date() }).where(eq(continuityMissions.missionId, mission.id));
      await transaction.update(missions).set({ version, updatedAt: new Date() }).where(eq(missions.id, mission.id));
      await transaction.insert(missionOutcomeEvents).values({ missionId: mission.id, needId: repair.affectedNeedId, type: "REPAIR_PAYMENT_PENDING", data: { repairAttemptId: repair.id, repairPaymentOrderId: order.id, providerOrderId: providerOrder.providerOrderId, amount: order.amount } });
      return this.publicOrder({ ...order, providerOrderId: providerOrder.providerOrderId });
    });
  }

  async processCheckoutCallback(input: { missionId?: string; paymentId: string; orderId: string; signature: string }) {
    const [order] = await this.database.select().from(continuityRepairPaymentOrders).where(eq(continuityRepairPaymentOrders.providerOrderId, input.orderId));
    if (!order) throw new PaymentError("PAYMENT_ORDER_NOT_FOUND", "Repair payment order is not known to MissionPay", 404);
    if (input.missionId && order.missionId !== input.missionId) throw new PaymentError("PAYMENT_ORDER_NOT_FOUND", "Repair payment order does not belong to this mission", 404);
    if (!this.provider.verifyCheckoutSignature({ expectedOrderId: order.providerOrderId!, paymentId: input.paymentId, signature: input.signature })) throw new PaymentError("PAYMENT_SIGNATURE_INVALID", "Repair checkout signature is invalid", 400);
    const payment = await this.provider.fetchPayment(input.paymentId);
    if (payment.providerOrderId !== order.providerOrderId || payment.amount !== order.amount || payment.currency !== order.currency) throw new PaymentError("PAYMENT_PROVIDER_MISMATCH", "Repair payment does not match the persisted order");
    if (payment.status !== "captured") throw new PaymentError("PAYMENT_NOT_CAPTURED", "Repair payment is authentic but not captured yet", 409);
    return this.finalizeCaptured(order.id, payment, true);
  }

  async processWebhookCapture(payment: ProviderPayment, eventId: string) {
    const [order] = await this.database.select().from(continuityRepairPaymentOrders).where(eq(continuityRepairPaymentOrders.providerOrderId, payment.providerOrderId));
    if (!order) throw new PaymentError("PAYMENT_ORDER_NOT_FOUND", "Repair payment order is not known to MissionPay", 404);
    if (payment.amount !== order.amount || payment.currency !== order.currency) throw new PaymentError("PAYMENT_AMOUNT_MISMATCH", "Webhook repair amount does not match the persisted order");
    return this.finalizeCaptured(order.id, payment, false, eventId);
  }

  async processWebhookFailure(payment: ProviderPayment, eventId: string) {
    const [found] = await this.database.select().from(continuityRepairPaymentOrders).where(eq(continuityRepairPaymentOrders.providerOrderId, payment.providerOrderId));
    if (!found) return { ignored: true };
    return this.database.transaction(async (transaction) => {
      const [order] = await transaction.select().from(continuityRepairPaymentOrders).where(eq(continuityRepairPaymentOrders.id, found.id)).for("update");
      if (!order || order.status === "CAPTURED" || order.status === "FAILED") return { ignored: true };
      const [repair] = await transaction.select().from(continuityRepairAttempts).where(eq(continuityRepairAttempts.id, order.repairAttemptId)).for("update");
      const [mission] = await transaction.select().from(missions).where(eq(missions.id, order.missionId)).for("update");
      if (!repair || !mission) return { ignored: true };
      await transaction.update(continuityRepairPaymentOrders).set({ status: "FAILED", updatedAt: new Date() }).where(eq(continuityRepairPaymentOrders.id, order.id));
      await transaction.update(continuityRepairAttempts).set({ status: "REPAIR_PAYMENT_FAILED", updatedAt: new Date() }).where(eq(continuityRepairAttempts.id, repair.id));
      await transaction.update(continuityMissions).set({ outcomeStatus: "DEGRADED", updatedAt: new Date() }).where(eq(continuityMissions.missionId, mission.id));
      const version = mission.version + 1;
      await transaction.update(missions).set({ version, updatedAt: new Date() }).where(eq(missions.id, mission.id));
      await transaction.insert(missionOutcomeEvents).values({ missionId: mission.id, needId: repair.affectedNeedId, type: "REPAIR_PAYMENT_FAILED", data: { repairAttemptId: repair.id, repairPaymentOrderId: order.id, providerPaymentId: payment.providerPaymentId, eventId } });
      return { ignored: false };
    });
  }

  async ownsProviderOrder(providerOrderId: string) {
    const [order] = await this.database.select({ id: continuityRepairPaymentOrders.id }).from(continuityRepairPaymentOrders).where(eq(continuityRepairPaymentOrders.providerOrderId, providerOrderId));
    return Boolean(order);
  }

  private publicOrder(order: { id: string; repairAttemptId: string; providerOrderId: string | null; amount: number; currency: string }) {
    return { repairPaymentOrderId: order.id, repairAttemptId: order.repairAttemptId, providerOrderId: order.providerOrderId, amount: order.amount, currency: order.currency, publicKeyId: this.provider.publicKeyId, type: "REPAIR" as const };
  }

  private async finalizeCaptured(orderId: string, payment: ProviderPayment, callbackVerified: boolean, eventId?: string) {
    return this.database.transaction(async (transaction) => {
      const [order] = await transaction.select().from(continuityRepairPaymentOrders).where(eq(continuityRepairPaymentOrders.id, orderId)).for("update");
      if (!order) throw new PaymentError("PAYMENT_ORDER_NOT_FOUND", "Repair payment order not found", 404);
      if (order.status === "CAPTURED") return { status: "REPAIR_PAYMENT_CAPTURED", duplicate: true, amount: order.amount, paymentId: payment.providerPaymentId };
      if (order.providerOrderId !== payment.providerOrderId || order.amount !== payment.amount || order.currency !== payment.currency) throw new PaymentError("PAYMENT_PROVIDER_MISMATCH", "Captured repair payment does not match persisted order");
      const [repair] = await transaction.select().from(continuityRepairAttempts).where(eq(continuityRepairAttempts.id, order.repairAttemptId)).for("update");
      const [mission] = await transaction.select().from(missions).where(eq(missions.id, order.missionId)).for("update");
      if (!repair || !mission || mission.status !== "PAID" || repair.status !== "REPAIR_PAYMENT_PENDING") throw new PaymentError("PAYMENT_NOT_ALLOWED", "Continuity repair is not awaiting payment");
      const [originalSelection] = await transaction.select().from(continuitySelections).where(eq(continuitySelections.id, repair.originalSelectionId)).for("update");
      const [replacement] = await transaction.select().from(marketOfferSnapshots).where(eq(marketOfferSnapshots.id, repair.replacementSnapshotId));
      if (!originalSelection || !replacement || !["DEGRADED", "SELECTED", "PRESERVED"].includes(originalSelection.status)) throw new PaymentError("PAYMENT_NOT_ALLOWED", "Repair component state is no longer valid");
      await transaction.insert(continuityRepairPaymentAttempts).values({ missionId: mission.id, repairPaymentOrderId: order.id, providerPaymentId: payment.providerPaymentId, providerOrderId: payment.providerOrderId, callbackVerified, providerStatus: payment.status, amount: payment.amount, status: "CAPTURED" }).onConflictDoNothing();
      await transaction.update(continuitySelections).set({ status: "REPLACED", updatedAt: new Date() }).where(eq(continuitySelections.id, originalSelection.id));
      await transaction.insert(continuitySelections).values({ missionId: mission.id, needId: repair.affectedNeedId, snapshotId: repair.replacementSnapshotId, status: "SELECTED", reservedPricePaise: repair.newPricePaise, replacedSelectionId: originalSelection.id });
      await transaction.update(continuityRepairPaymentOrders).set({ status: "CAPTURED", updatedAt: new Date() }).where(eq(continuityRepairPaymentOrders.id, order.id));
      await transaction.update(continuityRepairAttempts).set({ status: "REPAIR_PAYMENT_CAPTURED", updatedAt: new Date() }).where(eq(continuityRepairAttempts.id, repair.id));
      await transaction.update(continuityMissions).set({ outcomeStatus: "ACTIVE", updatedAt: new Date() }).where(eq(continuityMissions.missionId, mission.id));
      const version = mission.version + 1;
      await transaction.update(missions).set({ version, updatedAt: new Date() }).where(eq(missions.id, mission.id));
      await transaction.insert(missionOutcomeEvents).values({ missionId: mission.id, needId: repair.affectedNeedId, type: "REPAIR_PAYMENT_CAPTURED", data: { repairAttemptId: repair.id, repairPaymentOrderId: order.id, providerPaymentId: payment.providerPaymentId, amount: payment.amount, originalPaymentOrderId: repair.originalPaymentOrderId, replacementSnapshotId: repair.replacementSnapshotId, eventId } });
      await transaction.insert(missionEvents).values({ missionId: mission.id, type: "CONTINUITY_REPAIR_FINALIZED", missionVersion: version, data: { repairAttemptId: repair.id, repairPaymentOrderId: order.id, additionalPaymentPaise: payment.amount, originalCommittedAmountUnchanged: mission.committedAmount } });
      return { status: "REPAIR_PAYMENT_CAPTURED", duplicate: false, amount: order.amount, paymentId: payment.providerPaymentId, missionVersion: version };
    });
  }
}
