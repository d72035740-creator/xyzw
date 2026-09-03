import { z } from "zod";
import { errorResponse } from "@/domain/errors";
import { mockMerchantAdapter } from "@/commerce/mock-merchant-adapter";
import { merchantErrorResponse } from "@/commerce/merchant-errors";

const querySchema = z.object({
  category: z.enum(["CAKE", "FLOWERS", "RESTAURANT"]).optional(),
  readyBy: z.coerce.date().optional(),
});

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      category: url.searchParams.get("category") ?? undefined,
      readyBy: url.searchParams.get("readyBy") ?? undefined,
    });
    if (!parsed.success) {
      return Response.json(
        { error: { code: "INVALID_REQUEST", message: "Invalid offer search query" } },
        { status: 400 },
      );
    }
    const offers = await mockMerchantAdapter.searchOffers(parsed.data);
    return Response.json({ offers, deadlineInclusive: true });
  } catch (error) {
    try {
      return merchantErrorResponse(error);
    } catch (unknownError) {
      return errorResponse(unknownError);
    }
  }
}
