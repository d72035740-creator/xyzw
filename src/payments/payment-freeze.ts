import type { MissionStatus } from "@/domain/mission-state";

/** The mission state, not historical payment rows, owns the payment freeze. */
export function isMissionPaymentFrozen(mission: { status: MissionStatus }): boolean {
  return mission.status === "PAYMENT_PENDING";
}
