import { z } from "zod";
import { errorResponse } from "@/domain/errors";
import { mockMerchantAdapter } from "@/commerce/mock-merchant-adapter";
import { merchantErrorResponse } from "@/commerce/merchant-errors";
import { isDemoMutationEnabled } from "@/demo/demo-safety";

const changeSchema = z
  .object({
    expectedOfferVersion: z.number().int().positive(),
    missionId: z.uuid(),
    amount: z.number().int().positive().optional(),
    available: z.boolean().optional(),
    readyAt: z.coerce.date().optional(),
    vegetarian: z.boolean().nullable().optional(),
    servesPeople: z.number().int().positive().nullable().optional(),
  })
  .refine(
    (value) =>
      value.amount !== undefined ||
      value.available !== undefined ||
      value.readyAt !== undefined ||
      value.vegetarian !== undefined ||
      value.servesPeople !== undefined,
    { message: "At least one economic change is required" },
  );

export async function POST(
  request: Request,
  context: { params: Promise<{ offerId: string }> },
): Promise<Response> {
  if (!isDemoMutationEnabled()) {
    return Response.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
  }

  try {
    const parsed = changeSchema.safeParse(await request.json());
    if (!parsed.success) {
      return Response.json(
        { error: { code: "INVALID_REQUEST", message: "Invalid offer change" } },
        { status: 400 },
      );
    }
    const { offerId } = await context.params;
    const { expectedOfferVersion, missionId, ...changes } = parsed.data;
    const result = await mockMerchantAdapter.simulateOfferChange(
      offerId,
      expectedOfferVersion,
      changes,
      missionId,
    );
    return Response.json(result);
  } catch (error) {
    try {
      return merchantErrorResponse(error);
    } catch (unknownError) {
      return errorResponse(unknownError);
    }
  }
}
