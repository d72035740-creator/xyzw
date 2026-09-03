export type PlannerErrorCode =
  | "INVALID_AI_RESPONSE"
  | "PLAN_MISSION_MISMATCH"
  | "PLAN_INVALID_STATE"
  | "HALLUCINATED_OFFER"
  | "DUPLICATE_OFFER"
  | "DUPLICATE_CATEGORY"
  | "MISSING_REQUIRED_CATEGORY"
  | "OFFER_UNAVAILABLE"
  | "STALE_OFFER"
  | "DEADLINE_VIOLATION"
  | "VEGETARIAN_REQUIRED"
  | "INSUFFICIENT_CAPACITY"
  | "PLAN_BUDGET_EXCEEDED"
  | "PLANNER_CONFIGURATION_MISSING"
  | "PLANNER_PROVIDER_FAILED"
  | "DUPLICATE_PLAN_REQUEST"
  | "PLAN_EXECUTION_FAILED";

export class PlannerError extends Error {
  constructor(
    public readonly code: PlannerErrorCode,
    message: string,
    public readonly statusCode = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PlannerError";
  }
}

export function plannerErrorResponse(error: unknown): Response {
  if (error instanceof PlannerError) {
    return Response.json(
      { error: { code: error.code, message: error.message, details: error.details } },
      { status: error.statusCode },
    );
  }
  throw error;
}
