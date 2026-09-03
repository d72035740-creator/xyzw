import { repairMissionSchema, validationErrorResponse } from "@/api/schemas";
import { MerchantError, merchantErrorResponse } from "@/commerce/merchant-errors";
import { errorResponse, MissionError } from "@/domain/errors";
import { RepairError, repairErrorResponse } from "@/repair/repair-errors";
import { missionRepairService } from "@/repair/mission-repair.server";

export async function POST(
  request: Request,
  context: { params: Promise<{ missionId: string }> },
): Promise<Response> {
  try {
    const parsed = repairMissionSchema.safeParse(await request.json());
    if (!parsed.success) return validationErrorResponse(parsed.error);
    const { missionId } = await context.params;
    const rawRequestKey = request.headers.get("Idempotency-Key")?.trim();
    const result = await missionRepairService.repair({
      missionId,
      expectedVersion: parsed.data.expectedVersion,
      requestKey: rawRequestKey ? rawRequestKey.slice(0, 200) : undefined,
    });
    return Response.json({ repair: result }, { status: 201 });
  } catch (error) {
    if (error instanceof RepairError) return repairErrorResponse(error);
    if (error instanceof MerchantError) return merchantErrorResponse(error);
    if (error instanceof MissionError) return errorResponse(error);
    return errorResponse(error);
  }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ missionId: string }> },
): Promise<Response> {
  try {
    const { missionId } = await context.params;
    const attempt = await missionRepairService.getLatestAttempt(missionId);
    if (!attempt) {
      return Response.json(
        { error: { code: "REPAIR_NOT_FOUND", message: "No repair attempt exists" } },
        { status: 404 },
      );
    }
    return Response.json({ repair: attempt });
  } catch (error) {
    return errorResponse(error);
  }
}
