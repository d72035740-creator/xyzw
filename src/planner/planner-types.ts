import { z } from "zod";
import type { MerchantCategory } from "@/services/authority-store";

export const missionPlanProposalSchema = z
  .object({
    missionId: z.string().min(1),
    missionVersion: z.number().int().positive(),
    selectedOffers: z
      .array(
        z
          .object({
            offerId: z.string().min(1),
            observedOfferVersion: z.number().int().positive(),
            category: z.enum(["CAKE", "FLOWERS", "RESTAURANT"]),
            reason: z.string().max(500),
            constraintMapping: z
              .object({
                deadline: z.string().max(200).nullable(),
                vegetarian: z.string().max(200).nullable(),
                people: z.string().max(200).nullable(),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    rationale: z.string().max(1_000),
    totalAmount: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type MissionPlanProposal = z.infer<typeof missionPlanProposalSchema>;

export interface PlannerOfferInput {
  id: string;
  code: string | null;
  category: MerchantCategory;
  name: string;
  description: string | null;
  amount: number;
  available: boolean;
  readyAt: string;
  version: number;
  vegetarian: boolean | null;
  servesPeople: number | null;
}

export interface MissionPlanningInput {
  mission: {
    id: string;
    version: number;
    goal: string;
    budgetAmount: number;
    deadline: string;
    requiredCategories: MerchantCategory[];
    constraints: { people?: number; vegetarian?: boolean };
  };
  offers: PlannerOfferInput[];
}

export interface MissionPlanner {
  readonly plannerId: string;
  readonly modelId: string | null;
  createPlan(input: MissionPlanningInput): Promise<MissionPlanProposal>;
}

export interface ValidatedMissionPlan {
  proposal: MissionPlanProposal;
  actualTotalAmount: number;
  offers: PlannerOfferInput[];
}
