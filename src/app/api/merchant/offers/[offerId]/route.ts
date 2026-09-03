import { errorResponse } from "@/domain/errors";
import { mockMerchantAdapter } from "@/commerce/mock-merchant-adapter";
import { merchantErrorResponse } from "@/commerce/merchant-errors";

export async function GET(
  _request: Request,
  context: { params: Promise<{ offerId: string }> },
): Promise<Response> {
  try {
    const { offerId } = await context.params;
    const offer = await mockMerchantAdapter.getOffer(offerId);
    if (!offer) {
      return Response.json(
        { error: { code: "MERCHANT_OFFER_NOT_FOUND", message: "Offer not found" } },
        { status: 404 },
      );
    }
    return Response.json({ offer });
  } catch (error) {
    try {
      return merchantErrorResponse(error);
    } catch (unknownError) {
      return errorResponse(unknownError);
    }
  }
}
