export type MissionErrorCode =
  | "BUDGET_EXCEEDED"
  | "MISSION_NOT_FOUND"
  | "OFFER_NOT_FOUND"
  | "RESERVATION_NOT_FOUND"
  | "STALE_PLAN"
  | "STALE_OFFER"
  | "INVALID_MISSION_STATE"
  | "INVALID_RESERVATION_STATE"
  | "MISSION_CONSTRAINT_VIOLATION"
  | "CATEGORY_ALREADY_RESERVED";

export class MissionError extends Error {
  constructor(
    public readonly code: MissionErrorCode,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MissionError";
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof MissionError) {
    return Response.json(
      { error: { code: error.code, message: error.message, details: error.details } },
      { status: error.statusCode },
    );
  }

  console.error(error);
  return Response.json(
    { error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } },
    { status: 500 },
  );
}
