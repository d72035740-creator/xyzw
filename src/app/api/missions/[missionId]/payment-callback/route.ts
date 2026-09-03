import { checkoutCallbackSchema } from "@/api/payment-schemas";
import { missionPaymentService } from "@/payments/payment.server";
import { paymentErrorResponse } from "@/payments/payment-errors";

export async function POST(request: Request): Promise<Response> {
  try {
    const parsed = checkoutCallbackSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: { code: "INVALID_REQUEST", message: "Checkout callback is invalid" } }, { status: 400 });
    const result = await missionPaymentService.processCheckoutCallback({ paymentId: parsed.data.razorpay_payment_id, orderId: parsed.data.razorpay_order_id, signature: parsed.data.razorpay_signature });
    return Response.json(result);
  } catch (error) { return paymentErrorResponse(error); }
}
