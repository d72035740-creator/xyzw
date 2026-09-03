import { planMissionSchema, validationErrorResponse } from "@/api/schemas";
import { MerchantError, merchantErrorResponse } from "@/commerce/merchant-errors";
import { errorResponse, MissionError } from "@/domain/errors";
import { PlannerError, plannerErrorResponse } from "@/planner/planner-errors";
import { missionPlanningService } from "@/planner/mission-planning.server";

export async function POST(
  request: Request,
  context: { params: Promise<{ missionId: string }> },
): Promise<Response> {
  try {
    const parsed = planMissionSchema.safeParse(await request.json());
    if (!parsed.success) return validationErrorResponse(parsed.error);
    const { missionId } = await context.params;
    const rawRequestKey = request.headers.get("Idempotency-Key")?.trim();
    const requestKey = rawRequestKey ? rawRequestKey.slice(0, 200) : undefined;
    const result = await missionPlanningService.plan({
      missionId,
      expectedVersion: parsed.data.expectedVersion,
      requestKey,
    });
    return Response.json({ plan: result }, { status: 201 });
  } catch (error) {
    if (error instanceof PlannerError) return plannerErrorResponse(error);
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
    const run = await missionPlanningService.getLatestRun(missionId);
    if (!run) {
      return Response.json(
        { error: { code: "PLAN_NOT_FOUND", message: "No planning run exists" } },
        { status: 404 },
      );
    }
    return Response.json({ plan: run });
  } catch (error) {
    return errorResponse(error);
  }
}
