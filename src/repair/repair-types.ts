import { z } from "zod";
import type { MerchantOffer, MerchantReservation } from "@/commerce/merchant-adapter";
import type { MerchantCategory } from "@/services/authority-store";

const repairSelectionSchema = z
  .object({
    brokenReservationId: z.string().min(1),
    replacementOfferId: z.string().min(1),
    observedOfferVersion: z.number().int().positive(),
    reason: z.string().max(500),
    constraintMapping: z
      .object({
        deadline: z.string().max(200).nullable(),
        vegetarian: z.string().max(200).nullable(),
        people: z.string().max(200).nullable(),
      })
      .strict(),
  })
  .strict();

export const missionRepairProposalSchema = z
  .object({
    missionId: z.string().min(1),
    missionVersion: z.number().int().positive(),
    preserveReservationIds: z.array(z.string().min(1)).max(20),
    replacements: z.array(repairSelectionSchema).min(1).max(20),
    rationale: z.string().max(1_000),
    proposedTotalAmount: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type MissionRepairProposal = z.infer<typeof missionRepairProposalSchema>;

export interface RepairMissionSnapshot {
  id: string;
  version: number;
  status: "REPLANNING";
  budgetAmount: number;
  reservedAmount: number;
  committedAmount: number;
  deadline: Date;
  constraints: { people?: number; vegetarian?: boolean };
  requiredCategories: MerchantCategory[];
}

export interface RepairContext {
  mission: RepairMissionSnapshot;
  preserved: MerchantReservation[];
  broken: MerchantReservation[];
  candidatesByReservation: Map<string, MerchantOffer[]>;
}

export interface RepairPlanOption {
  replacements: Array<{ brokenReservationId: string; offer: MerchantOffer }>;
  changedItemCount: number;
  repairedTotalAmount: number;
  additionalCostAmount: number;
  constraintDegradationScore: number;
  score: number;
  tieBreaker: string;
}

export interface MissionRepairInput {
  mission: {
    id: string;
    version: number;
    budgetAmount: number;
    previousReservedAmount: number;
    deadline: string;
    constraints: { people?: number; vegetarian?: boolean };
  };
  preservedReservations: Array<{
    id: string;
    category: MerchantCategory;
    offerId: string;
    reservedPrice: number;
  }>;
  brokenReservations: Array<{
    id: string;
    category: MerchantCategory;
    offerId: string;
    reservedPrice: number;
    observedOfferVersion: number;
    currentOfferVersion: number;
  }>;
  rankedOptions: Array<{
    replacements: Array<{
      brokenReservationId: string;
      offerId: string;
      offerCode: string | null;
      observedOfferVersion: number;
      amount: number;
    }>;
    changedItemCount: number;
    repairedTotalAmount: number;
    score: number;
  }>;
}

export interface MissionRepairPlanner {
  readonly plannerId: string;
  readonly modelId: string | null;
  createRepair(input: MissionRepairInput): Promise<MissionRepairProposal>;
}

export interface ValidatedRepair {
  proposal: MissionRepairProposal;
  preserved: MerchantReservation[];
  broken: MerchantReservation[];
  replacements: Array<{ brokenReservation: MerchantReservation; offer: MerchantOffer }>;
  repairedTotalAmount: number;
  changedItemCount: number;
}
