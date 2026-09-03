export type MerchantErrorCode =
  | "MERCHANT_OFFER_NOT_FOUND"
  | "MERCHANT_RESERVATION_NOT_FOUND"
  | "STALE_OFFER"
  | "INVALID_OFFER_CHANGE";

export class MerchantError extends Error {
  constructor(
    public readonly code: MerchantErrorCode,
    message: string,
    public readonly statusCode = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MerchantError";
  }
}

export function merchantErrorResponse(error: unknown): Response {
  if (error instanceof MerchantError) {
    return Response.json(
      { error: { code: error.code, message: error.message, details: error.details } },
      { status: error.statusCode },
    );
  }
  throw error;
}
