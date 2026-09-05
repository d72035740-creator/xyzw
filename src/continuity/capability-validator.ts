import { ContinuityError, type MissionNeed, type MissionSpec } from "./types";

export type CapabilityOperator = "MIN" | "MAX" | "EQUAL" | "BOOLEAN" | "ENUM" | "COMPATIBLE_WITH";
export type CapabilityRequirement = {
  capability: string; operator: CapabilityOperator; value: string | number | boolean; unit?: string;
  hard: boolean; provenance: "USER_EXPLICIT" | "CORE_MISSION_INFERENCE";
};
export type CapabilityCheck = CapabilityRequirement & {
  observedValue: string | number | boolean | null; status: "VALID" | "MISMATCH" | "CAPABILITY_UNKNOWN";
  evidenceSource: string | null;
};
export type CapabilityCandidate = {
  id: string; needId: string; title: string; pricePaise: number; sourceUrl: string | null;
  sourceProvider: string; attributes: Record<string, unknown>; evidence: Record<string, unknown> | null;
};
type PortfolioAssessment = { offerSnapshotId: string; needId: string; identityConfidence: string; hardConstraints: { satisfied: boolean }; riskFlags: string[] };

const provenance = (need: MissionNeed): CapabilityRequirement["provenance"] => need.grounding?.inferenceClass === "EXPLICIT" ? "USER_EXPLICIT" : "CORE_MISSION_INFERENCE";

const booleanCapabilities = [
  { capability: "outdoor_suitability", requirement: /\boutdoor\b/i, evidence: /\b(?:outdoor|weatherproof|waterproof|ip\d{2})\b/i },
  { capability: "portable", requirement: /\bportable\b/i, evidence: /\b(?:portable|foldable|battery[- ]powered|carry)\b/i },
  { capability: "wireless", requirement: /\bwireless\b/i, evidence: /\b(?:wireless|wi-?fi|bluetooth)\b/i },
  { capability: "water_resistance", requirement: /\b(?:waterproof|weatherproof)\b/i, evidence: /\b(?:waterproof|weatherproof|ip\d{2})\b/i },
] as const;

const unitPattern = /(\d+(?:\.\d+)?)\s*(hz|w|watts?|va|wh|ah|lumens?|lm|inches?|inch|cm|m)\b/gi;
const unitName = (unit: string) => ({ watt: "W", watts: "W", w: "W", va: "VA", wh: "Wh", ah: "Ah", hz: "Hz", lumen: "lm", lumens: "lm", lm: "lm", inch: "in", inches: "in", cm: "cm", m: "m" })[unit.toLowerCase()] ?? unit;

export function deriveCapabilityRequirements(spec: MissionSpec, need: MissionNeed): CapabilityRequirement[] {
  const result: CapabilityRequirement[] = Object.entries(need.requiredAttributes).map(([capability, value]) => ({
    capability, operator: typeof value === "number" ? "MIN" : typeof value === "boolean" ? "BOOLEAN" : "EQUAL", value,
    hard: true, provenance: provenance(need),
  }));
  const semanticText = [need.label, ...(need.constraints ?? [])].join(" ");
  for (const definition of booleanCapabilities) if (definition.requirement.test(semanticText) && !result.some((item) => item.capability === definition.capability)) result.push({ capability: definition.capability, operator: "BOOLEAN", value: true, hard: true, provenance: provenance(need) });
  for (const match of semanticText.matchAll(unitPattern)) {
    const unit = unitName(match[2]);
    result.push({ capability: `rated_${unit.toLowerCase()}`, operator: "MIN", value: Number(match[1]), unit, hard: true, provenance: provenance(need) });
  }
  if (/\bsystem\b/i.test(need.label)) result.push({ capability: "complete_system", operator: "BOOLEAN", value: true, hard: true, provenance: provenance(need) });
  if (/\b(?:backup power|power source|generator|inverter|ups)\b/i.test(need.label) && spec.needs.length > 1) {
    result.push({ capability: "rated_power_output", operator: "MIN", value: 1, unit: "W/VA", hard: true, provenance: "CORE_MISSION_INFERENCE" });
    result.push({ capability: "mission_load_scope", operator: "COMPATIBLE_WITH", value: "dependent mission equipment", hard: true, provenance: "CORE_MISSION_INFERENCE" });
  }
  if (/\b(?:premium|reliable|reliability|best quality)\b/i.test(`${spec.goal} ${spec.globalConstraints.map((item) => item.description).join(" ")}`)) result.push({ capability: "quality_evidence", operator: "MIN", value: "corroborated", hard: false, provenance: "CORE_MISSION_INFERENCE" });
  const participantCount = Math.max(0, ...spec.participants.map((participant) => participant.count ?? 0));
  if (participantCount > 1) result.push({ capability: "mission_scale_people", operator: "MIN", value: participantCount, unit: "people", hard: false, provenance: "CORE_MISSION_INFERENCE" });
  return result;
}

type CapabilityEvidence = { text: string; source: string | null };
type ObservedCapability = { value: string | number | boolean; source: string | null };

function observedCapabilities(candidate: CapabilityCandidate, evidence: CapabilityEvidence[], qualityEvidenceCount: number) {
  const observed = new Map<string, ObservedCapability>();
  const set = (key: string, value: string | number | boolean, source: string | null) => observed.set(key, { value, source });
  for (const [key, value] of Object.entries(candidate.attributes)) if (["string", "number", "boolean"].includes(typeof value)) set(key, value as string | number | boolean, candidate.sourceUrl);
  const applyText = (text: string, source: string | null) => {
    for (const definition of booleanCapabilities) if (definition.evidence.test(text)) set(definition.capability, true, source);
    for (const match of text.matchAll(unitPattern)) {
      const unit = unitName(match[2]); const key = `rated_${unit.toLowerCase()}`; const value = Number(match[1]); const prior = observed.get(key);
      if (!prior || typeof prior.value !== "number" || value > prior.value) set(key, value, source);
    }
    if (/\b(?:powered|active|built[- ]in amplifier|integrated amplifier|all[- ]in[- ]one|party speaker|bluetooth speaker)\b/i.test(text)) set("complete_system", true, source);
    else if (/\bpassive\b/i.test(text) || (/\b(?:wall|ceiling)[-/ ]mounted speakers?\b/i.test(text) && !/\b(?:powered|active)\b/i.test(text))) set("complete_system", false, source);
    const narrowUse = text.match(/\b(?:designed|intended|backup|ups|power)\s+for\s+(?:a\s+)?([a-z][a-z0-9 -]{1,35})/i)?.[1]?.split(/[,.;|]/)[0]?.trim();
    if (narrowUse) set("mission_load_scope", `single device: ${narrowUse}`, source);
  };
  applyText(`${candidate.title} ${typeof candidate.evidence?.snippet === "string" ? candidate.evidence.snippet : ""}`, candidate.sourceUrl);
  for (const item of evidence) applyText(item.text, item.source);
  const ratedW = observed.get("rated_w"), ratedVa = observed.get("rated_va");
  const ratedOutput = Math.max(typeof ratedW?.value === "number" ? ratedW.value : 0, typeof ratedVa?.value === "number" ? ratedVa.value : 0);
  if (ratedOutput > 0) set("rated_power_output", ratedOutput, (typeof ratedW?.value === "number" && ratedW.value === ratedOutput ? ratedW : ratedVa)?.source ?? null);
  if (!observed.has("mission_load_scope") && (observed.has("rated_w") || observed.has("rated_va") || observed.has("rated_wh"))) set("mission_load_scope", "rated multi-device output", observed.get("rated_w")?.source ?? observed.get("rated_va")?.source ?? observed.get("rated_wh")?.source ?? null);
  if (qualityEvidenceCount >= 2) set("quality_evidence", "corroborated", evidence.find((item) => item.source)?.source ?? candidate.sourceUrl);
  return observed;
}

export function assessCapabilities(spec: MissionSpec, need: MissionNeed, candidate: CapabilityCandidate, evidence: CapabilityEvidence[] = [], qualityEvidenceCount = 0): CapabilityCheck[] {
  const observed = observedCapabilities(candidate, evidence, qualityEvidenceCount);
  return deriveCapabilityRequirements(spec, need).map((requirement) => {
    const observation = observed.get(requirement.capability); const actual = observation?.value ?? null;
    let status: CapabilityCheck["status"] = "CAPABILITY_UNKNOWN";
    if (actual !== null) {
      if (requirement.capability === "mission_load_scope") status = typeof actual === "string" && actual.startsWith("rated multi-device") ? "VALID" : "MISMATCH";
      else if (requirement.operator === "MIN") status = typeof requirement.value === "number" ? typeof actual === "number" && actual >= requirement.value ? "VALID" : "MISMATCH" : actual === requirement.value ? "VALID" : "MISMATCH";
      else if (requirement.operator === "MAX") status = typeof actual === "number" && typeof requirement.value === "number" && actual <= requirement.value ? "VALID" : "MISMATCH";
      else status = actual === requirement.value ? "VALID" : "MISMATCH";
    }
    return { ...requirement, observedValue: actual, status, evidenceSource: observation?.source ?? null };
  });
}

export function priceIdentityRisk(candidate: CapabilityCandidate, peers: CapabilityCandidate[], identityConfidence: "LOW" | "MEDIUM" | "HIGH") {
  const sorted = peers.map((item) => item.pricePaise).filter((price) => price > 0).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : candidate.pricePaise;
  const anomaly = sorted.length >= 4 && candidate.pricePaise < median * 0.25;
  const risks: string[] = [];
  if (anomaly) risks.push("PRICE_ANOMALY");
  if (anomaly && !/\b[A-Z]*\d+[A-Z0-9-]{2,}\b/i.test(candidate.title)) risks.push("VARIANT_AMBIGUOUS");
  if (identityConfidence === "LOW") risks.push("PRODUCT_IDENTITY_LOW_CONFIDENCE");
  return risks;
}

export function validateMissionPortfolio(spec: MissionSpec, selectedIds: string[], candidatesByNeed: Map<string, CapabilityCandidate[]>, assessments: PortfolioAssessment[]) {
  const reasons: string[] = [];
  const selected = selectedIds.flatMap((id) => [...candidatesByNeed.values()].flat().filter((candidate) => candidate.id === id));
  for (const need of spec.needs.filter((item) => item.required !== false)) {
    const matches = selected.filter((candidate) => candidate.needId === need.id);
    if (matches.length !== 1) reasons.push(`required need ${need.id} must have exactly one selected candidate`);
    const assessment = assessments.find((item) => item.offerSnapshotId === matches[0]?.id);
    if (!assessment?.hardConstraints.satisfied) reasons.push(`hard capabilities unresolved for ${need.id}`);
    if (assessment?.riskFlags.includes("VARIANT_AMBIGUOUS")) reasons.push(`variant identity ambiguous for ${need.id}`);
    if (assessment?.identityConfidence === "LOW" && matches[0]?.sourceProvider !== "missionpay-sandbox") reasons.push(`product identity confidence too low for ${need.id}`);
    const locationCompatibility = matches[0]?.evidence?.locationCompatibility;
    if (spec.location && locationCompatibility !== undefined && !["SUPPORTED_EVIDENCE", "UNKNOWN"].includes(String(locationCompatibility))) reasons.push(`location capability mismatch for ${need.id}`);
    for (const dependency of need.dependencies) {
      const dependencyCandidate = selected.find((candidate) => candidate.needId === dependency);
      if (!dependencyCandidate) reasons.push(`dependency ${dependency} missing for ${need.id}`);
      if (dependencyCandidate && /\b(?:connect|interface|adapter|cable)\b/i.test(need.label)) {
        const ownInterfaces = Array.isArray(matches[0]?.attributes.interfaces) ? matches[0].attributes.interfaces as string[] : [];
        const dependencyInterfaces = Array.isArray(dependencyCandidate.attributes.interfaces) ? dependencyCandidate.attributes.interfaces as string[] : [];
        if (!ownInterfaces.length || !dependencyInterfaces.length) reasons.push(`interface compatibility unproven between ${need.id} and ${dependency}`);
        else if (!ownInterfaces.some((value) => dependencyInterfaces.includes(value))) reasons.push(`interface capability mismatch between ${need.id} and ${dependency}`);
      }
    }
    const loadCheck = Boolean(matches[0] && /\b(?:backup power|power source|generator|inverter|ups)\b/i.test(need.label));
    if (loadCheck && matches[0]) {
      const output = Math.max(typeof matches[0].attributes.rated_w === "number" ? matches[0].attributes.rated_w as number : 0, typeof matches[0].attributes.rated_va === "number" ? matches[0].attributes.rated_va as number : 0);
      const knownLoad = need.dependencies.reduce((sum, dependency) => {
        const dependent = selected.find((candidate) => candidate.needId === dependency);
        return sum + (typeof dependent?.attributes.rated_w === "number" ? dependent.attributes.rated_w as number : 0);
      }, 0);
      if (knownLoad > 0 && output < knownLoad) reasons.push(`rated power output is below known dependent load for ${need.id}`);
    }
  }
  const total = selected.reduce((sum, candidate) => sum + candidate.pricePaise * (spec.needs.find((need) => need.id === candidate.needId)?.quantity ?? 1), 0);
  if (total > spec.budgetPaise) reasons.push("portfolio exceeds mission authority");
  if (new Set(selectedIds).size !== selectedIds.length) reasons.push("duplicate candidate selection");
  if (reasons.length) throw new ContinuityError("PORTFOLIO_NOT_MISSION_VALID", "Selected portfolio does not prove every mission capability", 409, { reasons });
  return { valid: true as const, totalPaise: total };
}
