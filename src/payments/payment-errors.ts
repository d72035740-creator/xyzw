export type PaymentErrorCode =
  | "PAYMENT_NOT_CONFIGURED"
  | "PAYMENT_NOT_ALLOWED"
  | "PAYMENT_STALE_MISSION"
  | "PAYMENT_ORDER_NOT_FOUND"
  | "PAYMENT_SIGNATURE_INVALID"
  | "PAYMENT_PROVIDER_MISMATCH"
  | "PAYMENT_AMOUNT_MISMATCH"
  | "PAYMENT_NOT_CAPTURED"
  | "PAYMENT_FAILED"
  | "PAYMENT_WEBHOOK_INVALID";

export class PaymentError extends Error {
  constructor(public readonly code: PaymentErrorCode, message: string, public readonly statusCode = 409, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "PaymentError";
  }
}

export function paymentErrorResponse(error: unknown): Response {
  if (error instanceof PaymentError) return Response.json({ error: { code: error.code, message: error.message, details: error.details } }, { status: error.statusCode });
  console.error(error);
  return Response.json({ error: { code: "INTERNAL_ERROR", message: "An unexpected payment error occurred" } }, { status: 500 });
}
