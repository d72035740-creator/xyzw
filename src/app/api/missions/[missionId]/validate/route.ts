import { validationErrorResponse, versionMutationSchema } from "@/api/schemas";
import { errorResponse } from "@/domain/errors";
import { missionAuthority } from "@/services/mission-authority.server";

export async function POST(
  request: Request,
  context: { params: Promise<{ missionId: string }> },
): Promise<Response> {
  try {
    const parsed = versionMutationSchema.safeParse(await request.json());
    if (!parsed.success) return validationErrorResponse(parsed.error);
    const { missionId } = await context.params;
    const result = await missionAuthority.validateMission(missionId, parsed.data.expectedVersion);
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
