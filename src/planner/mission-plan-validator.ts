import { MissionError } from "@/domain/errors";
import type { MissionStatus } from "@/domain/mission-state";
import type { MerchantCategory } from "@/services/authority-store";
import { PlannerError } from "./planner-errors";
import type {
  MissionPlanProposal,
  PlannerOfferInput,
  ValidatedMissionPlan,
} from "./planner-types";

export interface PlanValidationMission {
  id: string;
  version: number;
  status: MissionStatus;
  budgetAmount: number;
  deadline: Date;
  requiredCategories: MerchantCategory[];
  constraints: { people?: number; vegetarian?: boolean };
}

export class MissionPlanValidator {
  validate(
    mission: PlanValidationMission,
    proposal: MissionPlanProposal,
    persistedOffers: PlannerOfferInput[],
  ): ValidatedMissionPlan {
    if (proposal.missionId !== mission.id) {
      throw new PlannerError("PLAN_MISSION_MISMATCH", "Plan targets a different mission");
    }
    if (proposal.missionVersion !== mission.version) {
      throw new MissionError("STALE_PLAN", "AI plan observed a stale mission version", 409, {
        expectedVersion: proposal.missionVersion,
        currentVersion: mission.version,
      });
    }
    if (mission.status !== "PLANNING") {
      throw new PlannerError(
        "PLAN_INVALID_STATE",
        `Mission is not planning-compatible while ${mission.status}`,
        409,
      );
    }

    const byId = new Map(persistedOffers.map((offer) => [offer.id, offer]));
    const seenOffers = new Set<string>();
    const seenCategories = new Set<MerchantCategory>();
    const selected: PlannerOfferInput[] = [];

    for (const choice of proposal.selectedOffers) {
      if (seenOffers.has(choice.offerId)) {
        throw new PlannerError("DUPLICATE_OFFER", "Plan selects the same offer more than once");
      }
      seenOffers.add(choice.offerId);
      const offer = byId.get(choice.offerId);
      if (!offer) {
        throw new PlannerError("HALLUCINATED_OFFER", "Plan references an unknown offer", 400, {
          offerId: choice.offerId,
        });
      }
      if (!offer.available) {
        throw new PlannerError("OFFER_UNAVAILABLE", "Selected offer is unavailable", 409, {
          offerId: offer.id,
        });
      }
      if (offer.version !== choice.observedOfferVersion) {
        throw new PlannerError("STALE_OFFER", "Selected offer version is stale", 409, {
          offerId: offer.id,
          observedOfferVersion: choice.observedOfferVersion,
          currentOfferVersion: offer.version,
        });
      }
      if (new Date(offer.readyAt).getTime() > mission.deadline.getTime()) {
        throw new PlannerError("DEADLINE_VIOLATION", "Selected offer misses the mission deadline", 409, {
          offerId: offer.id,
        });
      }
      if (seenCategories.has(offer.category)) {
        throw new PlannerError(
          "DUPLICATE_CATEGORY",
          `Plan selects more than one ${offer.category} offer`,
        );
      }
      seenCategories.add(offer.category);
      if (
        offer.category === "RESTAURANT" &&
        mission.constraints.vegetarian === true &&
        offer.vegetarian !== true
      ) {
        throw new PlannerError("VEGETARIAN_REQUIRED", "Restaurant offer is not vegetarian");
      }
      if (
        mission.constraints.people !== undefined &&
        offer.category === "RESTAURANT" &&
        (offer.servesPeople === null || offer.servesPeople < mission.constraints.people)
      ) {
        throw new PlannerError("INSUFFICIENT_CAPACITY", "Restaurant offer serves too few people");
      }
      selected.push(offer);
    }

    for (const category of mission.requiredCategories) {
      if (!seenCategories.has(category)) {
        throw new PlannerError(
          "MISSING_REQUIRED_CATEGORY",
          `Plan is missing required category ${category}`,
        );
      }
    }
    if (seenCategories.size !== mission.requiredCategories.length) {
      throw new PlannerError("DUPLICATE_CATEGORY", "Plan includes a category the mission does not require");
    }

    const actualTotalAmount = selected.reduce((sum, offer) => sum + offer.amount, 0);
    if (!Number.isSafeInteger(actualTotalAmount) || actualTotalAmount > mission.budgetAmount) {
      throw new PlannerError("PLAN_BUDGET_EXCEEDED", "Persisted offer prices exceed mission budget", 409, {
        actualTotalAmount,
        budgetAmount: mission.budgetAmount,
      });
    }
    return { proposal, actualTotalAmount, offers: selected };
  }
}
