import { z } from "zod";
import { continuityRepairPaymentService } from "@/payments/continuity-repair-payment.server";
import { paymentErrorResponse } from "@/payments/payment-errors";

const schema = z.object({ expectedVersion: z.number().int().positive() }).strict();

export async function POST(request: Request, { params }: { params: Promise<{ missionId: string; repairAttemptId: string }> }) {
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: { code: "INVALID_REQUEST", message: "Only expectedVersion is accepted" } }, { status: 400 });
    const { missionId, repairAttemptId } = await params;
    return Response.json(await continuityRepairPaymentService.authorizeAdditional({ missionId, repairAttemptId, expectedVersion: parsed.data.expectedVersion }));
  } catch (error) { return paymentErrorResponse(error); }
}
