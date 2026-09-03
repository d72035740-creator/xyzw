import { errorResponse } from "@/domain/errors";
import { missionViewService } from "@/view/mission-view";

export async function GET(
  _request: Request,
  context: { params: Promise<{ missionId: string }> },
): Promise<Response> {
  try {
    const { missionId } = await context.params;
    const view = await missionViewService.get(missionId);
    if (!view) return Response.json({ error: { code: "MISSION_NOT_FOUND", message: "Mission not found" } }, { status: 404 });
    return Response.json({ view });
  } catch (error) {
    return errorResponse(error);
  }
}
