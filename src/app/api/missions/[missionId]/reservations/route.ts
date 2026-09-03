import { reserveOfferSchema, validationErrorResponse } from "@/api/schemas";
import { errorResponse } from "@/domain/errors";
import { missionAuthority } from "@/services/mission-authority.server";

export async function POST(
  request: Request,
  context: { params: Promise<{ missionId: string }> },
): Promise<Response> {
  try {
    const parsed = reserveOfferSchema.safeParse(await request.json());
    if (!parsed.success) return validationErrorResponse(parsed.error);
    const { missionId } = await context.params;
    const result = await missionAuthority.reserve(
      missionId,
      parsed.data.offerId,
      parsed.data.expectedVersion,
      parsed.data.expectedOfferVersion,
    );
    return Response.json(result, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
