export type RepairErrorCode =
  | "MISSION_NOT_INVALIDATED"
  | "NO_BROKEN_RESERVATION"
  | "NO_VALID_REPAIR"
  | "INVALID_REPAIR_PROPOSAL"
  | "NON_MINIMAL_REPAIR"
  | "STALE_OFFER"
  | "REPAIR_BUDGET_EXCEEDED"
  | "REPAIR_RESERVATION_FAILED"
  | "DUPLICATE_REPAIR_REQUEST";

export class RepairError extends Error {
  constructor(
    public readonly code: RepairErrorCode,
    message: string,
    public readonly statusCode = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RepairError";
  }
}

export function repairErrorResponse(error: RepairError): Response {
  return Response.json(
    { error: { code: error.code, message: error.message, details: error.details } },
    { status: error.statusCode },
  );
}
