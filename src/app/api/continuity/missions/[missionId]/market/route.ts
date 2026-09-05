import { z } from "zod";
import { continuityService } from "@/continuity/continuity-service";
import { continuityErrorResponse, withoutPreciseLocation } from "@/continuity/types";

const schema = z.object({
  missionId: z.string().uuid().optional(),
  missionVersion: z.number().int().positive().optional(),
  expectedVersion: z.number().int().positive().optional(),
}).strict().refine((data) => data.missionVersion !== undefined || data.expectedVersion !== undefined, {
  message: "missionVersion or expectedVersion is required",
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ missionId: string }> }
) {
  try {
    const { missionId } = await params;
    const body = schema.parse(await request.json());
    if (body.missionId && body.missionId !== missionId) {
      return Response.json(
        { error: { code: "INVALID_REQUEST", message: "missionId in payload does not match route" } },
        { status: 400 }
      );
    }
    const missionVersion = (body.missionVersion ?? body.expectedVersion)!;
    const view = await continuityService.build({ missionId, missionVersion });
    return Response.json(withoutPreciseLocation(view), { status: 200 });
  } catch (error) {
    return continuityErrorResponse(error);
  }
}
