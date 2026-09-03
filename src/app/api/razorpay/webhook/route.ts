import { missionPaymentService } from "@/payments/payment.server";
import { paymentErrorResponse } from "@/payments/payment-errors";
import { razorpayPaymentProvider } from "@/payments/payment.server";
import { db } from "@/db/client";
import { razorpayWebhookEvents } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const signature = request.headers.get("x-razorpay-signature") ?? "";
  if (!razorpayPaymentProvider.verifyWebhookSignature(rawBody, signature)) return Response.json({ error: { code: "PAYMENT_WEBHOOK_INVALID", message: "Invalid webhook signature" } }, { status: 400 });
  const eventId = request.headers.get("x-razorpay-event-id")?.trim();
  if (!eventId) return Response.json({ error: { code: "PAYMENT_WEBHOOK_INVALID", message: "Missing webhook event id" } }, { status: 400 });
  let payload: { event?: string; payload?: { payment?: { entity?: { id?: string; order_id?: string; status?: string; amount?: number; currency?: string } } } };
  try { payload = JSON.parse(rawBody) as typeof payload; } catch { return Response.json({ error: { code: "PAYMENT_WEBHOOK_INVALID", message: "Webhook body is invalid JSON" } }, { status: 400 }); }
  try {
    const [inserted] = await db.insert(razorpayWebhookEvents).values({ providerEventId: eventId, eventType: payload.event ?? "unknown", payload: { event: payload.event ?? "unknown" }, processingStatus: "RECEIVED" }).onConflictDoNothing().returning();
    if (!inserted) return Response.json({ acknowledged: true, duplicate: true });
    const entity = payload.payload?.payment?.entity;
    if (entity?.id && entity.order_id && typeof entity.amount === "number" && entity.currency) {
      const payment = { providerPaymentId: entity.id, providerOrderId: entity.order_id, status: entity.status ?? "", amount: entity.amount, currency: entity.currency };
      if (payload.event === "payment.captured") await missionPaymentService.processWebhookCapture(payment, eventId);
      else if (payload.event === "payment.failed") await missionPaymentService.processWebhookFailure(payment, eventId);
    }
    await db.update(razorpayWebhookEvents).set({ processingStatus: payload.event === "payment.authorized" ? "IGNORED" : "PROCESSED", processedAt: new Date() }).where(eq(razorpayWebhookEvents.providerEventId, eventId));
    return Response.json({ acknowledged: true });
  } catch (error) { return paymentErrorResponse(error); }
}
