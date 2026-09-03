import { errorResponse } from "@/domain/errors";
import { MissionService } from "@/services/mission-service";

const service = new MissionService();

export async function GET(
  _request: Request,
  context: { params: Promise<{ missionId: string }> },
): Promise<Response> {
  try {
    const { missionId } = await context.params;
    const mission = await service.get(missionId);
    if (!mission) {
      return Response.json(
        { error: { code: "MISSION_NOT_FOUND", message: "Mission not found" } },
        { status: 404 },
      );
    }
    return Response.json({ mission });
  } catch (error) {
    return errorResponse(error);
  }
}
