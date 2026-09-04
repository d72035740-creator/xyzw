import { ContinuityError, type MissionNeed, type MissionSpec } from "./types";

const personOrRelationship = /^(?:my\s+)?(?:girlfriend|boyfriend|partner|wife|husband|spouse|parents?|mother|father|mom|mum|dad|friends?|team|professor|teacher|colleagues?|coworkers?|guests?|people|person|children?|kids?)$/i;
const peopleContext = /^(?:for\s+)?(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:people|persons?|guests?|adults?|children|kids)$/i;
const dateOrTime = /^(?:today|tonight|tomorrow|yesterday|next\s+\w+|this\s+\w+|\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{4}-\d{2}-\d{2})$/i;
const budget = /^(?:under|below|within|budget|max(?:imum)?)?\s*(?:₹|rs\.?|inr|usd|\$)\s*[\d,.]+$/i;
const contextOnly = /^(?:birthday|anniversary|celebration|romantic|premium|cheap|affordable|urgent|special|surprise|nearby|local)$/i;

const explicitCategories = [
  { label: /\b(?:flowers?|bouquet)\b/i, goal: /\b(?:flowers?|bouquet)\b/i },
  { label: /\b(?:gifts?|present)\b/i, goal: /\b(?:gifts?|present)\b/i },
  { label: /\b(?:cakes?)\b/i, goal: /\b(?:cakes?)\b/i },
  { label: /\b(?:jewellery|jewelry|necklace|ring)\b/i, goal: /\b(?:jewellery|jewelry|necklace|ring)\b/i },
  { label: /\b(?:restaurant|dinner|dining|meal)\b/i, goal: /\b(?:restaurant|dinner|dining|meal)\b/i },
] as const;

function invalidReason(need: MissionNeed, goal: string, locationLabel?: string) {
  const label = need.label.trim();
  if (personOrRelationship.test(label) || peopleContext.test(label)) return "PARTICIPANT_OR_RELATIONSHIP";
  if (dateOrTime.test(label)) return "DATE_OR_TIME";
  if (budget.test(label)) return "BUDGET";
  if (contextOnly.test(label)) return "CONTEXT_ONLY";
  const locations = locationLabel?.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean) ?? [];
  if (locations.includes(label.toLowerCase())) return "LOCATION";
  if (explicitCategories.some((category) => category.label.test(label) && !category.goal.test(goal))) return "UNREQUESTED_COMMERCE_CATEGORY";
  return null;
}

export function validateMissionNeeds(spec: MissionSpec, sourceGoal = spec.goal): MissionSpec {
  for (const need of spec.needs) {
    const reason = invalidReason(need, sourceGoal, spec.location?.label);
    if (reason) {
      throw new ContinuityError(
        "INVALID_MISSION_NEED",
        `“${need.label}” is mission context, not something MissionPay can purchase or book.`,
        422,
        { needId: need.id, reason },
      );
    }
  }
  return spec;
}
