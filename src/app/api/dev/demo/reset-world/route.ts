import { mockMerchantAdapter } from "@/commerce/mock-merchant-adapter";
import { merchantErrorResponse } from "@/commerce/merchant-errors";
import { errorResponse } from "@/domain/errors";
import { isDemoMutationEnabled } from "@/demo/demo-safety";

export async function POST(): Promise<Response> {
  if (!isDemoMutationEnabled()) {
    return Response.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
  }
  try {
    const offer = (await mockMerchantAdapter.searchOffers({ availableOnly: false })).find((item) => item.code === "R1");
    if (!offer) return Response.json({ error: { code: "DEMO_OFFER_NOT_FOUND", message: "Demo offer R1 was not found" } }, { status: 404 });
    if (offer.amount === 555000 && offer.available) return Response.json({ offer });
    const result = await mockMerchantAdapter.simulateOfferChange(offer.id, offer.version, { amount: 555000, available: true });
    return Response.json({ offer: result.offer });
  } catch (error) {
    try { return merchantErrorResponse(error); } catch (unknownError) { return errorResponse(unknownError); }
  }
}
