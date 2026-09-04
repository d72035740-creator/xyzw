import { checkoutCallbackSchema } from "@/api/payment-schemas";
import { continuityRepairPaymentService } from "@/payments/continuity-repair-payment.server";
import { paymentErrorResponse } from "@/payments/payment-errors";

export async function POST(request: Request, { params }: { params: Promise<{ missionId: string }> }) {
  try {
    const parsed = checkoutCallbackSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: { code: "INVALID_REQUEST", message: "Repair checkout callback is invalid" } }, { status: 400 });
    const { missionId } = await params;
    return Response.json(await continuityRepairPaymentService.processCheckoutCallback({ missionId, paymentId: parsed.data.razorpay_payment_id, orderId: parsed.data.razorpay_order_id, signature: parsed.data.razorpay_signature }));
  } catch (error) { return paymentErrorResponse(error); }
}
