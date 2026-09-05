import { ContinuityError, type MissionNeed, type MissionSpec } from "./types";

export type MissionSemanticErrorCode =
  | "NO_ACTIONABLE_COMMERCE_NEEDS"
  | "PARTICIPANT_CLASSIFIED_AS_NEED"
  | "MISSION_NEED_TOO_VAGUE"
  | "UNSUPPORTED_OPTIONAL_NEED"
  | "OPTIONAL_ENHANCEMENT_NOT_ALLOWED"
  | "INVALID_GROUNDING"
  | "INVALID_DEADLINE_GROUNDING"
  | "INVALID_HARD_CONSTRAINT"
  | "INVALID_MISSION_DEPENDENCY"
  | "DUPLICATE_MISSION_NEED"
  | "INVALID_OUTCOME_REQUIREMENT";

const legacyPersonOrRelationship = /^(?:my\s+)?(?:girlfriend|boyfriend|partner|wife|husband|spouse|parents?|mother|father|mom|mum|dad|friends?|team|professor|teacher|colleagues?|coworkers?|guests?|people|person|children?|kids?)$/i;
const contextOnly = /^(?:setup|equipment|things?|everything|experience|event|occasion|person|people|guests?|location|budget|deadline)$/i;
const normalized = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function participantNeed(need: MissionNeed, spec: MissionSpec) {
  const label = normalized(need.label);
  if (legacyPersonOrRelationship.test(need.label.trim())) return true;
  if (/^(?:for\s+)?(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:people|persons?|guests?|participants?)$/i.test(need.label.trim())) return true;
  return spec.participants.some((participant) => {
    const person = normalized(participant.label);
    return person.length > 1 && (label === person || label === `my ${person}`);
  });
}

export function inspectMissionNeeds(spec: MissionSpec, sourceGoal = spec.goal): { valid: boolean; errorCodes: MissionSemanticErrorCode[] } {
  const errors = new Set<MissionSemanticErrorCode>();
  if (!spec.needs.length) errors.add("NO_ACTIONABLE_COMMERCE_NEEDS");
  const ids = new Set<string>();
  const goal = normalized(sourceGoal);
  const hasStatedDeadline = /\b(?:today|tonight|tomorrow|next\s+(?:day|week|month)|(?:within|in|have)\s+\d+\s+(?:minutes?|hours?|days?|weeks?)|by\s+[^,.]+)/i.test(sourceGoal);
  if ((spec.deadline || spec.deadlineText) && !hasStatedDeadline) errors.add("INVALID_DEADLINE_GROUNDING");

  for (const need of spec.needs) {
    const label = need.label.trim();
    if (ids.has(need.id)) errors.add("DUPLICATE_MISSION_NEED");
    ids.add(need.id);
    if (label.length < 3 || contextOnly.test(label)) errors.add("MISSION_NEED_TOO_VAGUE");
    if (spec.location && label === normalized(spec.location.label)) errors.add("MISSION_NEED_TOO_VAGUE");
    if (need.required === false) errors.add("UNSUPPORTED_OPTIONAL_NEED");
    if (participantNeed(need, spec)) errors.add("PARTICIPANT_CLASSIFIED_AS_NEED");
    if (need.grounding) {
      const { explicit, inferred, sourcePhrase, inferenceClass } = need.grounding;
      if (explicit === inferred) errors.add("INVALID_GROUNDING");
      const groundedInOutcome = Boolean(sourcePhrase && normalized(sourcePhrase) && goal.includes(normalized(sourcePhrase)));
      if (inferenceClass === "OPTIONAL_ENHANCEMENT") errors.add("OPTIONAL_ENHANCEMENT_NOT_ALLOWED");
      if (explicit && (inferenceClass !== "EXPLICIT" || !groundedInOutcome)) errors.add("INVALID_GROUNDING");
      if (inferred) {
        if (inferenceClass !== "CORE_REQUIREMENT" || !groundedInOutcome || need.required !== true) errors.add("INVALID_GROUNDING");
        if (!need.rationale || need.rationale.trim().length < 8) errors.add("INVALID_GROUNDING");
      }
    }
  }

  for (const need of spec.needs) if (need.dependencies.some((dependency) => !ids.has(dependency))) errors.add("INVALID_MISSION_DEPENDENCY");
  if (spec.outcome.requiredNeedIds.some((id) => !ids.has(id))) errors.add("INVALID_OUTCOME_REQUIREMENT");
  for (const constraint of spec.globalConstraints) {
    if (constraint.hard && constraint.type !== "BUDGET" && (!constraint.sourcePhrase || !goal.includes(normalized(constraint.sourcePhrase)))) errors.add("INVALID_HARD_CONSTRAINT");
  }
  return { valid: errors.size === 0, errorCodes: [...errors] };
}

export function validateMissionNeeds(spec: MissionSpec, sourceGoal = spec.goal): MissionSpec {
  const result = inspectMissionNeeds(spec, sourceGoal);
  if (!result.valid) {
    throw new ContinuityError("INVALID_MISSION_NEED", "Mission interpretation is not grounded enough for market execution.", 422, { reason: result.errorCodes[0], validatorErrorCodes: result.errorCodes });
  }
  return spec;
}
