import { z } from "zod";
import { continuityRepairPaymentService } from "@/payments/continuity-repair-payment.server";
import { paymentErrorResponse } from "@/payments/payment-errors";

const schema = z.object({ repairAttemptId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict();

export async function POST(request: Request, { params }: { params: Promise<{ missionId: string }> }) {
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: { code: "INVALID_REQUEST", message: "repairAttemptId and expectedVersion are required" } }, { status: 400 });
    const { missionId } = await params;
    const requestKey = request.headers.get("Idempotency-Key")?.trim().slice(0, 200) || undefined;
    return Response.json(await continuityRepairPaymentService.createOrder({ missionId, ...parsed.data, requestKey }), { status: 201 });
  } catch (error) { return paymentErrorResponse(error); }
}
