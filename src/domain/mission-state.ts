export const missionStatuses = [
  "DRAFT",
  "PLANNING",
  "PROPOSED",
  "RESERVING",
  "READY_TO_COMMIT",
  "PAYMENT_PENDING",
  "PAID",
  "DISTRIBUTING",
  "COMPLETED",
  "INVALIDATED",
  "REPLANNING",
  "PAYMENT_FAILED",
  "CANCELLED",
] as const;

export type MissionStatus = (typeof missionStatuses)[number];

const allowedTransitions: Readonly<Record<MissionStatus, readonly MissionStatus[]>> = {
  DRAFT: ["PLANNING", "CANCELLED"],
  PLANNING: ["PROPOSED", "INVALIDATED", "CANCELLED"],
  PROPOSED: ["RESERVING", "INVALIDATED", "CANCELLED"],
  RESERVING: ["READY_TO_COMMIT", "INVALIDATED", "CANCELLED"],
  READY_TO_COMMIT: ["PAYMENT_PENDING", "INVALIDATED", "CANCELLED"],
  PAYMENT_PENDING: ["PAID", "PAYMENT_FAILED"],
  PAID: ["DISTRIBUTING"],
  DISTRIBUTING: ["COMPLETED"],
  COMPLETED: [],
  INVALIDATED: ["REPLANNING", "CANCELLED"],
  REPLANNING: ["PROPOSED", "RESERVING", "CANCELLED"],
  PAYMENT_FAILED: ["READY_TO_COMMIT", "CANCELLED"],
  CANCELLED: [],
};

export function canTransition(from: MissionStatus, to: MissionStatus): boolean {
  return allowedTransitions[from].includes(to);
}

export function assertTransition(from: MissionStatus, to: MissionStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`INVALID_STATE_TRANSITION: ${from} -> ${to}`);
  }
}
