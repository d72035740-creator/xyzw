import { MissionError } from "@/domain/errors";
import { reservationTermsAreStale } from "@/commerce/merchant-world";
import { enumerateRepairOptions } from "./repair-ranking";
import { RepairError } from "./repair-errors";
import type { MissionRepairProposal, RepairContext, ValidatedRepair } from "./repair-types";

function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

export class MissionRepairValidator {
  validate(context: RepairContext, proposal: MissionRepairProposal): ValidatedRepair {
    const { mission } = context;
    if (proposal.missionId !== mission.id) {
      throw new RepairError("INVALID_REPAIR_PROPOSAL", "Repair targets a different mission");
    }
    if (proposal.missionVersion !== mission.version) {
      throw new MissionError("STALE_PLAN", "Repair proposal observed a stale mission version", 409, {
        expectedVersion: proposal.missionVersion,
        currentVersion: mission.version,
      });
    }
    if (mission.status !== "REPLANNING") {
      throw new RepairError("MISSION_NOT_INVALIDATED", "Mission is not in REPLANNING", 409);
    }
    const expectedPreserved = context.preserved.map((item) => item.id);
    if (!sameSet(expectedPreserved, proposal.preserveReservationIds)) {
      throw new RepairError(
        "INVALID_REPAIR_PROPOSAL",
        "Repair must preserve every unaffected reservation and no others",
      );
    }
    for (const preserved of context.preserved) {
      if (preserved.status !== "HELD" || reservationTermsAreStale(preserved, preserved.currentOffer)) {
        throw new RepairError("INVALID_REPAIR_PROPOSAL", "A proposed preserved reservation is stale");
      }
    }

    const brokenById = new Map(context.broken.map((item) => [item.id, item]));
    const proposedBrokenIds = proposal.replacements.map((item) => item.brokenReservationId);
    if (!sameSet([...brokenById.keys()], proposedBrokenIds)) {
      throw new RepairError("INVALID_REPAIR_PROPOSAL", "Repair must replace each broken reservation exactly once");
    }
    if (new Set(proposedBrokenIds).size !== proposedBrokenIds.length) {
      throw new RepairError("INVALID_REPAIR_PROPOSAL", "Repair contains duplicate broken reservations");
    }

    const replacements: ValidatedRepair["replacements"] = [];
    const selectedOfferIds = new Set<string>();
    for (const selection of proposal.replacements) {
      const broken = brokenById.get(selection.brokenReservationId)!;
      const offer = context.candidatesByReservation
        .get(selection.brokenReservationId)
        ?.find((candidate) => candidate.id === selection.replacementOfferId);
      if (!offer) {
        throw new RepairError("INVALID_REPAIR_PROPOSAL", "Replacement is not a persisted candidate", 409);
      }
      if (offer.version !== selection.observedOfferVersion) {
        throw new RepairError("STALE_OFFER", "Replacement offer version is stale", 409, {
          offerId: offer.id,
          observedOfferVersion: selection.observedOfferVersion,
          currentOfferVersion: offer.version,
        });
      }
      if (selectedOfferIds.has(offer.id) || offer.id === broken.offerId) {
        throw new RepairError("INVALID_REPAIR_PROPOSAL", "Replacement offer is duplicated or unchanged");
      }
      selectedOfferIds.add(offer.id);
      if (!offer.available || offer.category !== broken.currentOffer.category) {
        throw new RepairError("INVALID_REPAIR_PROPOSAL", "Replacement is unavailable or wrong category");
      }
      if (offer.readyAt.getTime() > mission.deadline.getTime()) {
        throw new RepairError("INVALID_REPAIR_PROPOSAL", "Replacement misses the mission deadline");
      }
      if (
        offer.category === "RESTAURANT" &&
        mission.constraints.vegetarian === true &&
        offer.vegetarian !== true
      ) {
        throw new RepairError("INVALID_REPAIR_PROPOSAL", "Replacement is not vegetarian");
      }
      if (
        offer.category === "RESTAURANT" &&
        mission.constraints.people !== undefined &&
        (offer.servesPeople === null || offer.servesPeople < mission.constraints.people)
      ) {
        throw new RepairError("INVALID_REPAIR_PROPOSAL", "Replacement serves too few people");
      }
      replacements.push({ brokenReservation: broken, offer });
    }

    const preservedTotal = context.preserved.reduce((sum, item) => sum + item.snapshot.reservedPrice, 0);
    const repairedTotalAmount = preservedTotal + replacements.reduce((sum, item) => sum + item.offer.amount, 0);
    if (
      !Number.isSafeInteger(repairedTotalAmount) ||
      repairedTotalAmount + mission.committedAmount > mission.budgetAmount
    ) {
      throw new RepairError("REPAIR_BUDGET_EXCEEDED", "Persisted replacement prices exceed authority", 409, {
        repairedTotalAmount,
        committedAmount: mission.committedAmount,
        budgetAmount: mission.budgetAmount,
      });
    }
    const ranked = enumerateRepairOptions({
      candidatesByReservation: context.candidatesByReservation,
      preservedTotalAmount: preservedTotal,
      previousReservedAmount: mission.reservedAmount,
    }).filter((option) => option.repairedTotalAmount + mission.committedAmount <= mission.budgetAmount);
    const best = ranked[0];
    if (!best) throw new RepairError("NO_VALID_REPAIR", "No valid repair remains", 409);
    const selectedKey = replacements.map((item) => item.offer.code ?? item.offer.id).sort().join("|");
    if (selectedKey !== best.tieBreaker) {
      throw new RepairError("NON_MINIMAL_REPAIR", "Proposal is valid but not the minimal deterministic repair", 409);
    }
    return {
      proposal,
      preserved: context.preserved,
      broken: context.broken,
      replacements,
      repairedTotalAmount,
      changedItemCount: replacements.length,
    };
  }
}
