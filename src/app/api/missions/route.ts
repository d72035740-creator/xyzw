import { createMissionSchema, validationErrorResponse } from "@/api/schemas";
import { errorResponse } from "@/domain/errors";
import { MissionService } from "@/services/mission-service";

const service = new MissionService();

export async function POST(request: Request): Promise<Response> {
  try {
    const parsed = createMissionSchema.safeParse(await request.json());
    if (!parsed.success) return validationErrorResponse(parsed.error);
    const mission = await service.create(parsed.data);
    return Response.json({ mission }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
