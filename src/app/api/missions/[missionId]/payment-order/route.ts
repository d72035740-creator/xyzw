import { paymentOrderSchema } from "@/api/payment-schemas";
import { continuityService } from "@/continuity/continuity-service";
import { ContinuityError, continuityErrorResponse } from "@/continuity/types";
import { MissionError, errorResponse } from "@/domain/errors";
import { missionPaymentService } from "@/payments/payment.server";
import { paymentErrorResponse } from "@/payments/payment-errors";
import { PaymentOrderCoordinator } from "@/payments/payment-order-coordinator";

const paymentOrders = new PaymentOrderCoordinator(missionPaymentService, continuityService);

export async function POST(request: Request, context: { params: Promise<{ missionId: string }> }): Promise<Response> {
  try {
    const parsed = paymentOrderSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: { code: "INVALID_REQUEST", message: "Only expectedVersion is accepted" } }, { status: 400 });
    const { missionId } = await context.params;
    const requestKey = request.headers.get("Idempotency-Key")?.trim().slice(0, 200) || undefined;
    return Response.json(await paymentOrders.createOrder({ missionId, expectedVersion: parsed.data.expectedVersion, requestKey }), { status: 201 });
  } catch (error) {
    if (error instanceof ContinuityError) return continuityErrorResponse(error);
    if (error instanceof MissionError) return errorResponse(error);
    return paymentErrorResponse(error);
  }
}
