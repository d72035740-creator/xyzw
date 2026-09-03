import { errorResponse } from "@/domain/errors";
import { mockMerchantAdapter } from "@/commerce/mock-merchant-adapter";
import { merchantErrorResponse } from "@/commerce/merchant-errors";

export async function GET(
  _request: Request,
  context: { params: Promise<{ reservationId: string }> },
): Promise<Response> {
  try {
    const { reservationId } = await context.params;
    const reservation = await mockMerchantAdapter.checkReservation(reservationId);
    if (!reservation) {
      return Response.json(
        { error: { code: "MERCHANT_RESERVATION_NOT_FOUND", message: "Reservation not found" } },
        { status: 404 },
      );
    }
    return Response.json({ reservation });
  } catch (error) {
    try {
      return merchantErrorResponse(error);
    } catch (unknownError) {
      return errorResponse(unknownError);
    }
  }
}
