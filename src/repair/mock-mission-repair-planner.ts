import { RepairError } from "./repair-errors";
import type {
  MissionRepairInput,
  MissionRepairPlanner,
  MissionRepairProposal,
} from "./repair-types";

export class MockMissionRepairPlanner implements MissionRepairPlanner {
  readonly plannerId = "mock-minimal-repair";
  readonly modelId = null;

  constructor(
    private readonly override?: (
      input: MissionRepairInput,
    ) => MissionRepairProposal | Promise<MissionRepairProposal>,
  ) {}

  async createRepair(input: MissionRepairInput): Promise<MissionRepairProposal> {
    if (this.override) return await this.override(input);
    const best = input.rankedOptions[0];
    if (!best) throw new RepairError("NO_VALID_REPAIR", "No deterministic repair option exists", 409);
    return {
      missionId: input.mission.id,
      missionVersion: input.mission.version,
      preserveReservationIds: input.preservedReservations.map((item) => item.id).sort(),
      replacements: best.replacements.map((item) => ({
        brokenReservationId: item.brokenReservationId,
        replacementOfferId: item.offerId,
        observedOfferVersion: item.observedOfferVersion,
        reason: `Minimal deterministic replacement ${item.offerCode ?? item.offerId}`,
        constraintMapping: { deadline: "server validates", vegetarian: null, people: null },
      })),
      rationale: "Fewest changed components, then lowest persisted cost, then stable code",
      proposedTotalAmount: best.repairedTotalAmount,
    };
  }
}
