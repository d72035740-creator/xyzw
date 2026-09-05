import { createHash } from "node:crypto";
import { ContinuityError, type MissionNeed, type MissionSpec } from "./types";
import { assessCapabilities, priceIdentityRisk, type CapabilityCheck } from "./capability-validator";

export type EvidenceType = "OFFICIAL_SPEC" | "PROFESSIONAL_REVIEW" | "COMMUNITY" | "COMPARISON" | "MERCHANT";
export type EvidenceConfidence = "LOW" | "MEDIUM" | "HIGH";
export type DecisionProfile = "CHEAPEST" | "BEST_VALUE" | "MAX_PERFORMANCE";
export type PortfolioType = "CHEAPEST_VALID" | "BEST_VALUE" | "MAX_PERFORMANCE";

export type ProductIdentity = { brand?: string; model?: string; modelNumber?: string; size?: string; variant?: string; generation?: string };
export type EvidenceRecordInput = {
  missionId: string; needId: string; offerSnapshotId: string; type: EvidenceType; sourceName: string;
  sourceUrl?: string; title: string; snippet?: string; observedAt: Date; evidenceMode: "SEARCH_EVIDENCE" | "PAGE_EVIDENCE";
  productIdentityConfidence: EvidenceConfidence; extractedFacts: Record<string, unknown>; sentiment: Record<string, unknown>;
};
export type CandidateAssessment = {
  offerSnapshotId: string; needId: string; title: string; currentPricePaise: number;
  identity: ProductIdentity; identityConfidence: EvidenceConfidence;
  hardConstraints: { satisfied: boolean; failures: string[]; unknowns: string[] };
  capabilityChecks: CapabilityCheck[];
  scores: { requirementFit: number; productQuality: number; communityReliability: number; evidenceConfidence: number; priceEfficiency: number; utility: number };
  evidenceCounts: { officialSources: number; professionalSources: number; communityDiscussions: number; merchantSources: number };
  recurringPositives: string[]; recurringNegatives: string[]; riskFlags: string[];
};
export type DecisionPortfolio = {
  type: PortfolioType; label: string; itemSnapshotIds: string[]; totalPricePaise: number; missionUtility: number;
  marginalValue: number; tradeOff: string;
};
export type DecisionWeights = { requirementFit: number; productQuality: number; communityReliability: number; priceEfficiency: number; evidenceConfidence: number };
export type DecisionResult = { profile: DecisionProfile; weights: DecisionWeights; evidence: EvidenceRecordInput[]; assessments: CandidateAssessment[]; portfolios: DecisionPortfolio[]; selectedPortfolio: PortfolioType };

export type SnapshotCandidate = {
  id: string; needId: string; title: string; merchantName: string; sourceUrl: string | null; sourceProvider: string;
  pricePaise: number; attributes: Record<string, unknown>; evidence: Record<string, unknown> | null;
};

export type SearchEvidence = { title: string; link?: string; snippet?: string; source?: string };
const EVIDENCE_TIMEOUT_MS = 3_000;

async function settleBounded<T>(jobs: Array<() => Promise<T>>, concurrency = 8) {
  const settled: PromiseSettledResult<T>[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const index = next++;
      try { settled[index] = { status: "fulfilled", value: await jobs[index]() }; }
      catch (reason) { settled[index] = { status: "rejected", reason }; }
    }
  }));
  return settled;
}

function evidenceDiagnostic(event: string, data: Record<string, unknown>) { console.info(event, data); }

export class EvidenceSearchConnector {
  private readonly cache = new Map<string, { expiresAt: number; results: SearchEvidence[] }>();
  constructor(private readonly apiKey = process.env.SERPAPI_API_KEY ?? "", private readonly fetcher: typeof fetch = fetch) {}
  async search(query: string): Promise<SearchEvidence[]> {
    if (!this.apiKey) throw new ContinuityError("EVIDENCE_CONFIGURATION_MISSING", "SERPAPI_API_KEY is required for live evidence research", 503);
    const cached = this.cache.get(query);
    if (cached && cached.expiresAt > Date.now()) return cached.results;
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google"); url.searchParams.set("q", query); url.searchParams.set("gl", "in"); url.searchParams.set("hl", "en"); url.searchParams.set("num", "5"); url.searchParams.set("api_key", this.apiKey);
    const startedAt = Date.now();
    let response: Response;
    try { response = await this.fetcher(url, { signal: AbortSignal.timeout(EVIDENCE_TIMEOUT_MS) }); }
    catch (error) { evidenceDiagnostic("EVIDENCE_REQUEST_END", { provider: "serpapi-google", elapsedMs: Date.now() - startedAt, error: error instanceof Error ? error.name : "request_failed" }); throw error; }
    evidenceDiagnostic("EVIDENCE_REQUEST_END", { provider: "serpapi-google", httpStatus: response.status, elapsedMs: Date.now() - startedAt });
    if (!response.ok) throw new ContinuityError("EVIDENCE_SEARCH_FAILED", "Evidence search failed", 502, { providerStatus: response.status });
    const body = await response.json() as { organic_results?: SearchEvidence[] };
    const results = (body.organic_results ?? []).filter((result) => result.title).slice(0, 5);
    const ttlMs = /official specifications/i.test(query) ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    if (this.cache.size >= 500) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(query, { expiresAt: Date.now() + ttlMs, results });
    return results;
  }
}

export class SerperEvidenceSearchConnector extends EvidenceSearchConnector {
  private readonly serperCache = new Map<string, { expiresAt: number; results: SearchEvidence[] }>();
  constructor(private readonly serperApiKey = process.env.SERPER_API_KEY ?? "", private readonly serperFetcher: typeof fetch = fetch) { super("", serperFetcher); }
  override async search(query: string): Promise<SearchEvidence[]> {
    if (!this.serperApiKey) throw new ContinuityError("EVIDENCE_CONFIGURATION_MISSING", "SERPER_API_KEY is required when the Serper market provider is selected", 503);
    const cached = this.serperCache.get(query); if (cached && cached.expiresAt > Date.now()) return cached.results;
    const startedAt = Date.now(); let response: Response;
    try { response = await this.serperFetcher("https://google.serper.dev/search", { method: "POST", headers: { "X-API-KEY": this.serperApiKey, "Content-Type": "application/json" }, body: JSON.stringify({ q: query, gl: "in", hl: "en", num: 5 }), signal: AbortSignal.timeout(EVIDENCE_TIMEOUT_MS) }); }
    catch (error) { evidenceDiagnostic("EVIDENCE_REQUEST_END", { provider: "serper", elapsedMs: Date.now() - startedAt, error: error instanceof Error ? error.name : "request_failed" }); throw error; }
    evidenceDiagnostic("EVIDENCE_REQUEST_END", { provider: "serper", httpStatus: response.status, elapsedMs: Date.now() - startedAt });
    if (!response.ok) throw new ContinuityError("EVIDENCE_SEARCH_FAILED", "Evidence search failed", 502, { providerStatus: response.status });
    const body = await response.json() as { organic?: SearchEvidence[] };
    const results = (body.organic ?? []).filter((result) => result.title).slice(0, 5); const ttlMs = /official specifications/i.test(query) ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    this.serperCache.set(query, { expiresAt: Date.now() + ttlMs, results }); return results;
  }
}

function defaultEvidenceConnector() { return process.env.MISSIONPAY_MARKET_PROVIDER === "serper" ? new SerperEvidenceSearchConnector() : new EvidenceSearchConnector(); }

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
const modelPattern = /\b\d{2,}[A-Z][A-Z0-9-]*\b/i;
const sizePattern = /\b\d{2,3}(?:\.\d+)?\s*(?:inch|inches|\")\b/i;
const stopBrands = new Set(["the", "new", "gaming", "wireless", "mechanical", "ergonomic"]);

export function productIdentity(title: string): ProductIdentity {
  const words = title.trim().split(/\s+/);
  const brand = words.find((word) => /^[a-z][a-z0-9-]+$/i.test(word) && !stopBrands.has(word.toLowerCase()));
  const modelNumber = title.match(modelPattern)?.[0]?.replaceAll(" ", "");
  return { brand, model: modelNumber, modelNumber, size: title.match(sizePattern)?.[0], variant: title.match(/\b(?:Pro|Max|Plus|Mini)\b/i)?.[0], generation: title.match(/\b(?:Gen(?:eration)?\s*\d+|\d+(?:st|nd|rd|th)\s+Gen(?:eration)?)\b/i)?.[0] };
}

function identityConfidence(identity: ProductIdentity, evidenceTitle: string): EvidenceConfidence {
  if (identity.modelNumber && evidenceTitle.replaceAll(" ", "").toLowerCase().includes(identity.modelNumber.toLowerCase())) return "HIGH";
  if (identity.brand && evidenceTitle.toLowerCase().includes(identity.brand.toLowerCase())) return "MEDIUM";
  return "LOW";
}

function sourceHost(link?: string) {
  try { return link ? new URL(link).hostname.replace(/^www\./, "") : "search-result"; } catch { return "search-result"; }
}
function meaningfulOverlap(requirement: string, candidate: string) {
  const ignored = new Set(["the", "a", "an", "for", "with", "and", "or", "of", "to", "in", "on", "equipment", "product"]);
  const tokens = (value: string) => (value.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((token) => token.length > 2 && !ignored.has(token));
  const candidateTokens = new Set(tokens(candidate));
  return tokens(requirement).some((token) => candidateTokens.has(token));
}

function evidenceTypeFor(requested: EvidenceType, identity: ProductIdentity, link?: string): EvidenceType {
  const host = sourceHost(link).toLowerCase();
  if (requested === "OFFICIAL_SPEC") {
    const brand = identity.brand?.toLowerCase().replace(/[^a-z0-9]/g, "");
    return brand && host.replace(/[^a-z0-9]/g, "").includes(brand) ? "OFFICIAL_SPEC" : "PROFESSIONAL_REVIEW";
  }
  if (requested === "COMMUNITY" && !host.includes("reddit.com")) return "PROFESSIONAL_REVIEW";
  return requested;
}

export function inferDecisionProfile(goal: string, declaredIntent?: MissionSpec["optimizationIntent"]): { profile: DecisionProfile; weights: DecisionWeights } {
  if (declaredIntent === "CHEAPEST") return { profile: "CHEAPEST", weights: { requirementFit: .3, productQuality: .15, communityReliability: .05, priceEfficiency: .45, evidenceConfidence: .05 } };
  if (declaredIntent === "MAX_PERFORMANCE") return { profile: "MAX_PERFORMANCE", weights: { requirementFit: .3, productQuality: .4, communityReliability: .1, priceEfficiency: .05, evidenceConfidence: .15 } };
  if (declaredIntent === "RELIABILITY") return { profile: "BEST_VALUE", weights: { requirementFit: .25, productQuality: .2, communityReliability: .3, priceEfficiency: .1, evidenceConfidence: .15 } };
  if (declaredIntent === "BEST_VALUE" || declaredIntent === "BALANCED") return { profile: "BEST_VALUE", weights: { requirementFit: .3, productQuality: .25, communityReliability: .15, priceEfficiency: .15, evidenceConfidence: .15 } };
  if (/\b(?:cheapest|lowest price|most affordable)\b/i.test(goal)) return { profile: "CHEAPEST", weights: { requirementFit: .3, productQuality: .15, communityReliability: .05, priceEfficiency: .45, evidenceConfidence: .05 } };
  if (/\b(?:max(?:imum)? performance|best performance|highest performance)\b/i.test(goal)) return { profile: "MAX_PERFORMANCE", weights: { requirementFit: .3, productQuality: .4, communityReliability: .1, priceEfficiency: .05, evidenceConfidence: .15 } };
  if (/\b(?:reliable|reliability)\b/i.test(goal)) return { profile: "BEST_VALUE", weights: { requirementFit: .25, productQuality: .2, communityReliability: .3, priceEfficiency: .1, evidenceConfidence: .15 } };
  if (/\b(?:best reviewed|reviews?)\b/i.test(goal)) return { profile: "BEST_VALUE", weights: { requirementFit: .25, productQuality: .2, communityReliability: .15, priceEfficiency: .1, evidenceConfidence: .3 } };
  return { profile: "BEST_VALUE", weights: { requirementFit: .3, productQuality: .25, communityReliability: .15, priceEfficiency: .15, evidenceConfidence: .15 } };
}

function hardConstraints(need: MissionNeed, candidate: SnapshotCandidate) {
  const failures: string[] = []; const unknowns: string[] = [];
  for (const [key, expected] of Object.entries(need.requiredAttributes)) {
    const actual = candidate.attributes[key];
    if (actual === undefined || actual === null) unknowns.push(key);
    else if (typeof expected === "number" ? typeof actual !== "number" || actual < expected : actual !== expected) failures.push(key);
  }
  return { satisfied: failures.length === 0 && unknowns.length === 0, failures, unknowns };
}

const positiveThemes = [/motion clarity/i, /build quality/i, /battery life/i, /comfortable/i, /reliable/i, /easy setup/i, /good value/i];
const negativeThemes = [/backlight bleed/i, /weak stand/i, /ghosting/i, /battery issue/i, /software issue/i, /disconnect/i, /poor support/i, /noisy/i];
function themes(records: EvidenceRecordInput[], patterns: RegExp[]) {
  return patterns.filter((pattern) => records.filter((record) => pattern.test(`${record.title} ${record.snippet ?? ""}`)).length >= 2).map((pattern) => pattern.source.replace(/\\b|\\/g, "").replace(/\/i$/, ""));
}

function combinations<T>(groups: T[][], limit = 625): T[][] {
  let result: T[][] = [[]];
  for (const group of groups) result = result.flatMap((prefix) => group.map((item) => [...prefix, item])).slice(0, limit);
  return result;
}

function diverseShortlist(candidates: SnapshotCandidate[], limit: number) {
  const cheapest = [...candidates].sort((a, b) => a.pricePaise - b.pricePaise);
  const strength = [...candidates].sort((a, b) => {
    const score = (candidate: SnapshotCandidate) => Object.entries(candidate.attributes).reduce((total, [key, value]) => total + (key.startsWith("rated_") && typeof value === "number" ? value : value === true ? 1_000 : 0), 0) + (typeof candidate.evidence?.rating === "number" ? candidate.evidence.rating as number * 100 : 0);
    return score(b) - score(a) || b.pricePaise - a.pricePaise;
  });
  const strongestEvidence = [...candidates].sort((a, b) => {
    const score = (candidate: SnapshotCandidate) => (typeof candidate.evidence?.rating === "number" ? candidate.evidence.rating as number * 1_000 : 0) + (typeof candidate.evidence?.reviewCount === "number" ? Math.min(500, candidate.evidence.reviewCount as number) : 0);
    return score(b) - score(a) || b.pricePaise - a.pricePaise;
  });
  const premium = [...candidates].sort((a, b) => b.pricePaise - a.pricePaise);
  // Retain a deliberate mix: cheapest, strongest capability, strongest evidence,
  // and premium/high-utility candidates before filling the remaining capacity.
  const selected = [cheapest[0], strength[0], strongestEvidence[0], premium[0], ...cheapest, ...strength, ...strongestEvidence, ...premium]
    .filter((candidate): candidate is SnapshotCandidate => Boolean(candidate));
  return [...new Map(selected.map((candidate) => [candidate.id, candidate])).values()].slice(0, Math.max(limit, 4));
}

export function optimizePortfolios(groups: CandidateAssessment[][], budgetPaise: number, requireLiveQualityEvidence = false): DecisionPortfolio[] {
  if (groups.some((group) => !group.length)) throw new ContinuityError("NO_FEASIBLE_MARKET_OFFER", "Every required need needs at least one evidence-qualified candidate", 409);
  const feasible = combinations(groups.map((group) => group.slice(0, 5))).map((items) => ({ items, total: items.reduce((sum, item) => sum + item.currentPricePaise, 0), utility: items.reduce((sum, item) => sum + item.scores.utility, 0) / items.length })).filter((portfolio) => portfolio.total <= budgetPaise);
  if (!feasible.length) throw new ContinuityError("BUDGET_EXCEEDED", "No complete evidence-qualified portfolio fits inside authority", 409);
  const cheapest = [...feasible].sort((a, b) => a.total - b.total || b.utility - a.utility)[0];
  const qualityEligible = feasible.filter((portfolio) => portfolio.items.every((item) =>
    !item.riskFlags.includes("PRICE_ANOMALY")
    && !item.riskFlags.includes("VARIANT_AMBIGUOUS")
    && item.identityConfidence !== "LOW"
    && item.scores.requirementFit === 100
    && item.scores.productQuality >= 55
    && item.scores.evidenceConfidence >= 50
    && (!requireLiveQualityEvidence || item.identityConfidence === "HIGH" || item.evidenceCounts.officialSources + item.evidenceCounts.professionalSources > 0),
  ));
  if (!qualityEligible.length) throw new ContinuityError("NO_QUALITY_MARKET_OFFER", "No sufficiently identified, capable, and evidenced portfolio is available within authority", 409);
  const performance = [...qualityEligible].sort((a, b) => b.utility - a.utility || a.total - b.total)[0];
  const bestValue = [...qualityEligible].sort((a, b) => {
    const aGain = Math.max(0, a.utility - cheapest.utility), bGain = Math.max(0, b.utility - cheapest.utility);
    const aExtra = Math.max(1, a.total - cheapest.total), bExtra = Math.max(1, b.total - cheapest.total);
    // Best Value rewards verified utility gained per additional paise more than
    // Max Performance does; price remains a constraint, never a quality proxy.
    return (b.utility + 40 * bGain / bExtra * 100000) - (a.utility + 40 * aGain / aExtra * 100000) || a.total - b.total;
  })[0];
  const make = (type: PortfolioType, label: string, value: typeof cheapest, tradeOff: string): DecisionPortfolio => ({ type, label, itemSnapshotIds: value.items.map((item) => item.offerSnapshotId), totalPricePaise: value.total, missionUtility: Math.round(value.utility), marginalValue: Math.round(Math.max(0, value.utility - cheapest.utility) * 100000 / Math.max(1, value.total - cheapest.total) * 100) / 100, tradeOff });
  const portfolios = [make("CHEAPEST_VALID", "Cheapest valid", cheapest, "Lowest-priced complete mission satisfying verified hard requirements."), make("BEST_VALUE", "Best value", bestValue, "Strongest marginal quality and evidence gain for the additional spend."), make("MAX_PERFORMANCE", "Max performance", performance, "Highest ranking utility found without exceeding authority.")];
  return portfolios.map((portfolio, index) => {
    const duplicate = portfolios.some((other, otherIndex) => otherIndex < index && other.itemSnapshotIds.join("|") === portfolio.itemSnapshotIds.join("|"));
    return duplicate ? { ...portfolio, label: `${portfolio.label} · Same optimal portfolio`, tradeOff: `SAME OPTIMAL PORTFOLIO — ${portfolio.tradeOff}` } : portfolio;
  });
}

export class EvidenceDecisionEngine {
  constructor(private readonly connector = defaultEvidenceConnector()) {}

  async decide(missionId: string, spec: MissionSpec, candidatesByNeed: Map<string, SnapshotCandidate[]>, live: boolean): Promise<DecisionResult> {
    const { profile, weights } = inferDecisionProfile(spec.goal, spec.optimizationIntent);
    const shortlists = spec.needs.map((need) => diverseShortlist(candidatesByNeed.get(need.id) ?? [], live ? 8 : 12));
    if (shortlists.some((shortlist) => !shortlist.length)) throw new ContinuityError("NO_FEASIBLE_MARKET_OFFER", "No candidate satisfies every deterministic hard constraint", 409);

    const evidence: EvidenceRecordInput[] = [];
    for (const candidate of shortlists.flat()) evidence.push({ missionId, needId: candidate.needId, offerSnapshotId: candidate.id, type: "MERCHANT", sourceName: candidate.merchantName, sourceUrl: candidate.sourceUrl ?? undefined, title: candidate.title, snippet: typeof candidate.evidence?.snippet === "string" ? candidate.evidence.snippet : undefined, observedAt: new Date(), evidenceMode: "SEARCH_EVIDENCE", productIdentityConfidence: "HIGH", extractedFacts: candidate.attributes, sentiment: {} });

    if (live) {
      // The diversified shortlist is ordered intentionally; research each retained
      // representative rather than only the first cheap search results.
      const researchJobs: Array<() => Promise<{ candidate: SnapshotCandidate; type: EvidenceType; results: SearchEvidence[] }>> = shortlists.flatMap((shortlist) => shortlist.slice(0, 4).map((candidate) => {
        const identity = productIdentity(candidate.title); const identityQuery = [identity.brand, identity.modelNumber, identity.size].filter(Boolean).join(" ") || candidate.title;
        return async () => ({ candidate, type: "OFFICIAL_SPEC" as const, results: await this.connector.search(`${identityQuery} official specifications`) });
      }));
      const settled = await settleBounded(researchJobs);
      for (const result of settled) {
        if (result.status !== "fulfilled") continue;
        const { candidate, type, results } = result.value; const identity = productIdentity(candidate.title);
        for (const item of results) evidence.push({ missionId, needId: candidate.needId, offerSnapshotId: candidate.id, type: evidenceTypeFor(type, identity, item.link), sourceName: item.source ?? sourceHost(item.link), sourceUrl: item.link, title: item.title, snippet: item.snippet, observedAt: new Date(), evidenceMode: "SEARCH_EVIDENCE", productIdentityConfidence: identityConfidence(identity, item.title), extractedFacts: {}, sentiment: {} });
      }
    }

    const assessments: CandidateAssessment[] = [];
    for (const [needIndex, need] of spec.needs.entries()) {
      const shortlist = shortlists[needIndex];
      const preliminary = shortlist.map((candidate) => {
        const records = evidence.filter((record) => record.offerSnapshotId === candidate.id); const identity = productIdentity(candidate.title);
        const official = records.filter((record) => record.type === "OFFICIAL_SPEC" && record.productIdentityConfidence !== "LOW").length;
        const professional = records.filter((record) => record.type === "PROFESSIONAL_REVIEW" && record.productIdentityConfidence !== "LOW").length;
        const community = records.filter((record) => record.type === "COMMUNITY" && record.productIdentityConfidence !== "LOW").length;
        const positives = themes(records, positiveThemes), negatives = themes(records, negativeThemes);
        const semanticIdentity = meaningfulOverlap(need.label, candidate.title) && Boolean(candidate.sourceUrl);
        const confidenceScore = clamp(30 + (identity.modelNumber ? 20 : 0) + (semanticIdentity ? 20 : 0) + Math.min(25, official * 10) + Math.min(20, professional * 4) + Math.min(10, community * 2));
        const quality = clamp(55 + Math.min(20, official * 8) + Math.min(15, professional * 4) + positives.length * 4 - negatives.length * 5);
        const reliability = clamp(50 + positives.length * 7 - negatives.length * 10 + Math.min(15, community));
        const identityLevel: EvidenceConfidence = confidenceScore >= 75 ? "HIGH" : confidenceScore >= 50 ? "MEDIUM" : "LOW";
        const capabilityChecks = assessCapabilities(spec, need, candidate, records.map((record) => ({ text: `${record.title} ${record.snippet ?? ""}`, source: record.sourceUrl ?? null })), official + professional + community);
        const legacy = hardConstraints(need, candidate);
        const failures = [...legacy.failures, ...capabilityChecks.filter((check) => check.hard && check.status === "MISMATCH").map((check) => check.capability)];
        const unknowns = [...legacy.unknowns, ...capabilityChecks.filter((check) => check.hard && check.status === "CAPABILITY_UNKNOWN").map((check) => check.capability)];
        const risks = priceIdentityRisk(candidate, shortlist, identityLevel);
        return { candidate, records, identity, official, professional, community, positives, negatives, confidenceScore, identityLevel, quality, reliability, capabilityChecks, hard: { satisfied: failures.length === 0 && unknowns.length === 0, failures, unknowns }, risks };
      });
      const numericCapabilityKeys = [...new Set(preliminary.flatMap((entry) => Object.entries(entry.candidate.attributes).filter(([key, value]) => key.startsWith("rated_") && typeof value === "number").map(([key]) => key)))];
      const capabilityCeilings = new Map(numericCapabilityKeys.map((key) => [key, Math.max(...preliminary.map((entry) => typeof entry.candidate.attributes[key] === "number" ? entry.candidate.attributes[key] as number : 0))]));
      const ratios = preliminary.map((entry) => entry.quality / entry.candidate.pricePaise); const maxRatio = Math.max(...ratios);
      for (const [index, entry] of preliminary.entries()) {
        const priceEfficiency = clamp(ratios[index] / maxRatio * 100);
        const hardChecks = entry.capabilityChecks.filter((check) => check.hard); const validChecks = hardChecks.filter((check) => check.status === "VALID").length;
        const requirementFit = hardChecks.length ? clamp(validChecks / hardChecks.length * 100) : 100;
        const capabilityStrength = numericCapabilityKeys.length ? numericCapabilityKeys.reduce((sum, key) => sum + (typeof entry.candidate.attributes[key] === "number" ? entry.candidate.attributes[key] as number : 0) / Math.max(1, capabilityCeilings.get(key) ?? 1), 0) / numericCapabilityKeys.length : 0;
        const quality = clamp(entry.quality + capabilityStrength * 20);
        const anomalyPenalty = entry.risks.includes("PRICE_ANOMALY") && !(entry.identityLevel === "HIGH" && entry.official >= 2) ? 25 : 0;
        const utility = clamp(requirementFit * weights.requirementFit + quality * weights.productQuality + entry.reliability * weights.communityReliability + priceEfficiency * weights.priceEfficiency + entry.confidenceScore * weights.evidenceConfidence - anomalyPenalty);
        assessments.push({ offerSnapshotId: entry.candidate.id, needId: need.id, title: entry.candidate.title, currentPricePaise: entry.candidate.pricePaise * need.quantity, identity: entry.identity, identityConfidence: entry.identityLevel, hardConstraints: entry.hard, capabilityChecks: entry.capabilityChecks, scores: { requirementFit, productQuality: quality, communityReliability: entry.reliability, evidenceConfidence: entry.confidenceScore, priceEfficiency, utility }, evidenceCounts: { officialSources: entry.official, professionalSources: entry.professional, communityDiscussions: entry.community, merchantSources: 1 }, recurringPositives: entry.positives, recurringNegatives: entry.negatives, riskFlags: [...entry.risks, ...(entry.confidenceScore < 50 ? ["LOW_EVIDENCE_CONFIDENCE"] : []), ...(entry.negatives.length ? ["RECURRING_COMPLAINTS"] : [])] });
      }
    }
    const portfolios = optimizePortfolios(spec.needs.map((need) => assessments.filter((assessment) => assessment.needId === need.id && assessment.hardConstraints.satisfied && (!live || assessment.identityConfidence !== "LOW") && !assessment.riskFlags.includes("VARIANT_AMBIGUOUS")).sort((a, b) => b.scores.utility - a.scores.utility).slice(0, 5)), spec.budgetPaise, live);
    const selectedPortfolio: PortfolioType = profile === "CHEAPEST" ? "CHEAPEST_VALID" : profile === "MAX_PERFORMANCE" ? "MAX_PERFORMANCE" : "BEST_VALUE";
    return { profile, weights, evidence, assessments, portfolios, selectedPortfolio };
  }
}

export function decisionCacheKey(candidate: SnapshotCandidate) {
  return createHash("sha256").update(JSON.stringify([candidate.sourceProvider, candidate.title, candidate.attributes])).digest("hex");
}
