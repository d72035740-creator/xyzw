import { PlannerError } from "./planner-errors";
import type { MissionPlanner, MissionPlanningInput, MissionPlanProposal } from "./planner-types";

export class MockMissionPlanner implements MissionPlanner {
  readonly plannerId = "mock-canonical";
  readonly modelId = null;

  constructor(
    private readonly override?: (
      input: MissionPlanningInput,
    ) => MissionPlanProposal | Promise<MissionPlanProposal>,
  ) {}

  async createPlan(input: MissionPlanningInput): Promise<MissionPlanProposal> {
    if (this.override) return await this.override(input);
    const selected = ["C1", "F1", "R1"].map((code) => {
      const offer = input.offers.find((candidate) => candidate.code === code);
      if (!offer) throw new PlannerError("HALLUCINATED_OFFER", `Mock offer ${code} is missing`);
      return {
        offerId: offer.id,
        observedOfferVersion: offer.version,
        category: offer.category,
        reason: `Canonical deterministic selection ${code}`,
        constraintMapping: { deadline: "checked by server", vegetarian: null, people: null },
      };
    });
    return {
      missionId: input.mission.id,
      missionVersion: input.mission.version,
      selectedOffers: selected,
      rationale: "Canonical deterministic birthday plan",
      totalAmount: selected.reduce(
        (sum, choice) => sum + input.offers.find((offer) => offer.id === choice.offerId)!.amount,
        0,
      ),
    };
  }
}
