import type { MerchantOffer } from "@/commerce/merchant-adapter";
import type { RepairPlanOption } from "./repair-types";

export const CHANGED_ITEM_PENALTY = 1_000_000_000;
export const ADDITIONAL_COST_PENALTY = 1_000;
export const CONSTRAINT_DEGRADATION_PENALTY = 1;

export function rankRepairOptions(options: RepairPlanOption[]): RepairPlanOption[] {
  return [...options].sort(
    (left, right) =>
      left.changedItemCount - right.changedItemCount ||
      left.repairedTotalAmount - right.repairedTotalAmount ||
      left.score - right.score ||
      left.tieBreaker.localeCompare(right.tieBreaker),
  );
}

export function enumerateRepairOptions(input: {
  candidatesByReservation: Map<string, MerchantOffer[]>;
  preservedTotalAmount: number;
  previousReservedAmount: number;
}): RepairPlanOption[] {
  const entries = [...input.candidatesByReservation.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length === 0 || entries.some(([, offers]) => offers.length === 0)) return [];

  let combinations: Array<Array<{ brokenReservationId: string; offer: MerchantOffer }>> = [[]];
  for (const [brokenReservationId, offers] of entries) {
    combinations = combinations.flatMap((combination) =>
      offers.map((offer) => [...combination, { brokenReservationId, offer }]),
    );
  }

  return rankRepairOptions(combinations
    .filter((combination) => new Set(combination.map((item) => item.offer.id)).size === combination.length)
    .map((replacements): RepairPlanOption => {
      const repairedTotalAmount =
        input.preservedTotalAmount + replacements.reduce((sum, item) => sum + item.offer.amount, 0);
      const changedItemCount = replacements.length;
      const additionalCostAmount = Math.max(0, repairedTotalAmount - input.previousReservedAmount);
      const constraintDegradationScore = 0;
      const score =
        CHANGED_ITEM_PENALTY * changedItemCount +
        ADDITIONAL_COST_PENALTY * additionalCostAmount +
        CONSTRAINT_DEGRADATION_PENALTY * constraintDegradationScore;
      const tieBreaker = replacements
        .map((item) => item.offer.code ?? item.offer.id)
        .sort()
        .join("|");
      return {
        replacements,
        changedItemCount,
        repairedTotalAmount,
        additionalCostAmount,
        constraintDegradationScore,
        score,
        tieBreaker,
      };
    }));
}
