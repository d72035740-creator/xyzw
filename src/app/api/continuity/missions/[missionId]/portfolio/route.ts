import { z } from "zod";
import { continuityService } from "@/continuity/continuity-service";
import { continuityErrorResponse, withoutPreciseLocation } from "@/continuity/types";

const schema = z.object({ type: z.enum(["CHEAPEST_VALID", "BEST_VALUE", "MAX_PERFORMANCE"]), expectedVersion: z.number().int().positive() }).strict();

export async function POST(request: Request, { params }: { params: Promise<{ missionId: string }> }) {
  try {
    const body = schema.parse(await request.json()); const { missionId } = await params;
    return Response.json(withoutPreciseLocation(await continuityService.selectPortfolio(missionId, body.type, body.expectedVersion)));
  } catch (error) { return continuityErrorResponse(error); }
}
