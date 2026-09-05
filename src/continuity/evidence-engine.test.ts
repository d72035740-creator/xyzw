import { describe, expect, it, vi } from "vitest";
import { EvidenceDecisionEngine, EvidenceSearchConnector, inferDecisionProfile, optimizePortfolios, productIdentity, type CandidateAssessment } from "./evidence-engine";
import { validateMissionPortfolio } from "./capability-validator";
import { extractListingCapabilities } from "./market-gateway";
import type { MissionSpec } from "./types";

function assessment(offerSnapshotId: string, needId: string, price: number, utility: number): CandidateAssessment {
  return { offerSnapshotId, needId, title: offerSnapshotId, currentPricePaise: price, identity: {}, identityConfidence: "MEDIUM", hardConstraints: { satisfied: true, failures: [], unknowns: [] }, capabilityChecks: [], scores: { requirementFit: 100, productQuality: utility, communityReliability: 50, evidenceConfidence: 60, priceEfficiency: 70, utility }, evidenceCounts: { officialSources: 1, professionalSources: 1, communityDiscussions: 1, merchantSources: 1 }, recurringPositives: [], recurringNegatives: [], riskFlags: [] };
}

describe("EvidenceDecisionEngine", () => {
  it("routes evidence through SerpAPI Google Search without leaking the key", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ organic_results: [{ title: "Official specifications", link: "https://maker.test/model", snippet: "165Hz IPS" }] }), { status: 200 }));
    const results = await new EvidenceSearchConnector("secret-key", fetcher).search("LG 24GN650 official specifications");
    const requested = new URL(String(fetcher.mock.calls[0][0]));
    expect(requested.searchParams.get("engine")).toBe("google");
    expect(requested.searchParams.get("q")).toContain("official specifications");
    expect(results[0].link).toBe("https://maker.test/model");
    expect(JSON.stringify(results)).not.toContain("secret-key");
  });

  it("reuses cached research results without repeating provider calls", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ organic_results: [{ title: "LG 24GN650 specs", link: "https://lg.com/specs" }] }), { status: 200 }));
    const connector = new EvidenceSearchConnector("secret-key", fetcher);
    await connector.search("LG 24GN650 official specifications");
    await connector.search("LG 24GN650 official specifications");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps close product variants separate", () => {
    expect(productIdentity("LG 24GN650 24 inch monitor")).toMatchObject({ brand: "LG", modelNumber: "24GN650", size: "24 inch" });
    expect(productIdentity("LG 27GN650 27 inch monitor").modelNumber).not.toBe(productIdentity("LG 24GN650 24 inch monitor").modelNumber);
  });

  it("infers transparent intent profiles", () => {
    expect(inferDecisionProfile("build the cheapest setup").profile).toBe("CHEAPEST");
    expect(inferDecisionProfile("best performance under budget").profile).toBe("MAX_PERFORMANCE");
    expect(inferDecisionProfile("best value gaming setup").profile).toBe("BEST_VALUE");
    expect(inferDecisionProfile("ordinary setup", "MAX_PERFORMANCE").profile).toBe("MAX_PERFORMANCE");
  });

  it("allocates marginal budget to the stronger monitor gain instead of a weak keyboard upgrade", () => {
    const portfolios = optimizePortfolios([
      [assessment("monitor-cheap", "monitor", 1_300_000, 60), assessment("monitor-value", "monitor", 1_450_000, 90), assessment("monitor-performance", "monitor", 1_899_900, 93)],
      [assessment("keyboard-cheap", "keyboard", 400_000, 82), assessment("keyboard-premium", "keyboard", 800_000, 87)],
    ], 2_250_000);
    expect(portfolios.find((portfolio) => portfolio.type === "CHEAPEST_VALID")?.itemSnapshotIds).toEqual(["monitor-cheap", "keyboard-cheap"]);
    expect(portfolios.find((portfolio) => portfolio.type === "BEST_VALUE")?.itemSnapshotIds).toEqual(["monitor-value", "keyboard-cheap"]);
    expect(portfolios.find((portfolio) => portfolio.type === "MAX_PERFORMANCE")?.itemSnapshotIds).toEqual(["monitor-value", "keyboard-premium"]);
  });

  it("labels legitimately identical strategy results as the same optimal portfolio", () => {
    const portfolios = optimizePortfolios([[assessment("only-valid", "need", 100_000, 80)]], 200_000);
    expect(portfolios.find((portfolio) => portfolio.type === "BEST_VALUE")?.tradeOff).toContain("SAME OPTIMAL PORTFOLIO");
    expect(portfolios.find((portfolio) => portfolio.type === "MAX_PERFORMANCE")?.tradeOff).toContain("SAME OPTIMAL PORTFOLIO");
  });

  it("does not require live evidence calls in sandbox mode", async () => {
    const connector = { search: vi.fn() } as unknown as EvidenceSearchConnector;
    const engine = new EvidenceDecisionEngine(connector);
    const spec = { goal: "best value monitor", budgetPaise: 2_000_000, currency: "INR" as const, participants: [], needs: [{ id: "monitor", label: "144Hz monitor", kind: "PRODUCT" as const, quantity: 1, searchQueries: ["monitor"], requiredAttributes: { refreshRateHz: 144 }, dependencies: [] }], globalConstraints: [], outcome: { requiredNeedIds: ["monitor"], predicates: [] }, repairAuthority: { allowAutomaticSubstitution: true, maxAdditionalSpendPaise: 0 } };
    const candidates = new Map([["monitor", [{ id: "one", needId: "monitor", title: "LG 24GN650 144Hz", merchantName: "Merchant", sourceUrl: "https://merchant.test", sourceProvider: "sandbox", pricePaise: 1_500_000, attributes: { refreshRateHz: 144 }, evidence: null }]]]);
    const result = await engine.decide("mission", spec, candidates, false);
    expect(connector.search).not.toHaveBeenCalled();
    expect(result.selectedPortfolio).toBe("BEST_VALUE");
    expect(result.assessments[0].hardConstraints.satisfied).toBe(true);
  });

  it("includes requested quantity in mission-level authority optimization", async () => {
    const connector = { search: vi.fn() } as unknown as EvidenceSearchConnector;
    const engine = new EvidenceDecisionEngine(connector);
    const spec = { goal: "buy two monitors", budgetPaise: 2_000_000, currency: "INR" as const, participants: [], needs: [{ id: "monitor", label: "144Hz monitor", kind: "PRODUCT" as const, quantity: 2, searchQueries: ["monitor"], requiredAttributes: { refreshRateHz: 144 }, dependencies: [] }], globalConstraints: [], outcome: { requiredNeedIds: ["monitor"], predicates: [] }, repairAuthority: { allowAutomaticSubstitution: true, maxAdditionalSpendPaise: 0 } };
    const candidates = new Map([["monitor", [{ id: "one", needId: "monitor", title: "LG 24GN650 144Hz", merchantName: "Merchant", sourceUrl: "https://merchant.test", sourceProvider: "sandbox", pricePaise: 1_500_000, attributes: { refreshRateHz: 144 }, evidence: null }]]]);
    await expect(engine.decide("mission", spec, candidates, false)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  it("rejects low-capability rooftop candidates and produces mission-valid diverse portfolios", async () => {
    const spec: MissionSpec = {
      goal: "Set up a premium outdoor movie night on a rooftop for 20 people within 24 hours", budgetPaise: 10_000_000, currency: "INR", optimizationIntent: "BEST_VALUE",
      participants: [{ label: "people", count: 20, role: "attendee" }], preferences: [],
      needs: [
        { id: "projection", label: "Outdoor projector", kind: "PRODUCT", quantity: 1, required: true, searchQueries: ["outdoor projector"], requiredAttributes: {}, dependencies: [] },
        { id: "screen", label: "Outdoor projection screen", kind: "PRODUCT", quantity: 1, required: true, searchQueries: ["outdoor projection screen"], requiredAttributes: {}, dependencies: [] },
        { id: "audio", label: "Outdoor audio system", kind: "PRODUCT", quantity: 1, required: true, searchQueries: ["outdoor audio system"], requiredAttributes: {}, dependencies: [] },
        { id: "power", label: "Backup power source", kind: "PRODUCT", quantity: 1, required: true, searchQueries: ["backup power source"], requiredAttributes: {}, dependencies: ["projection", "audio"] },
        { id: "lighting", label: "Outdoor ambient lighting", kind: "PRODUCT", quantity: 1, required: true, searchQueries: ["outdoor ambient lighting"], requiredAttributes: {}, dependencies: [] },
        { id: "connectivity", label: "HDMI connectivity", kind: "PRODUCT", quantity: 1, required: true, searchQueries: ["HDMI connectivity"], requiredAttributes: {}, dependencies: ["projection"] },
      ],
      globalConstraints: [], outcome: { requiredNeedIds: ["projection", "screen", "audio", "power", "lighting", "connectivity"], predicates: [] }, repairAuthority: { allowAutomaticSubstitution: true, maxAdditionalSpendPaise: 0 },
    };
    const candidate = (id: string, needId: string, title: string, pricePaise: number) => ({ id, needId, title, merchantName: "Observed merchant", sourceUrl: `https://merchant.test/${id}`, sourceProvider: "serpapi-google-shopping", pricePaise, attributes: extractListingCapabilities(title), evidence: { snippet: title } });
    const candidates = new Map<string, ReturnType<typeof candidate>[]>([
      ["projection", [candidate("projection-outlier", "projection", "Outdoor projection device accessory variant", 47_100), candidate("projection-base", "projection", "P300 Outdoor projector HDMI 3000 lumens", 1_500_000), candidate("projection-value", "projection", "P500 Outdoor projector HDMI 5000 lumens", 2_000_000), candidate("projection-max", "projection", "P700 Outdoor projector HDMI 7000 lumens", 2_500_000)]],
      ["screen", [candidate("screen-base", "screen", "S100 Portable outdoor projection screen 100 inch", 400_000), candidate("screen-max", "screen", "S160 Portable outdoor projection screen 160 inch", 800_000)]],
      ["audio", [candidate("audio-passive", "audio", "A100 Outdoor wall-mounted speakers", 250_000), candidate("audio-base", "audio", "A200 Powered outdoor audio system 160W", 700_000), candidate("audio-max", "audio", "A400 Powered outdoor audio system 400W", 1_200_000)]],
      ["power", [candidate("power-router", "power", "12V 2A mini UPS power backup for router", 120_000), candidate("power-base", "power", "B600 Backup power source 600VA", 450_000), candidate("power-max", "power", "B1200 Backup power source 1200VA", 750_000)]],
      ["lighting", [candidate("lighting-base", "lighting", "L100 Outdoor ambient lighting 20W", 100_000), candidate("lighting-max", "lighting", "L300 Outdoor ambient lighting 60W", 250_000)]],
      ["connectivity", [candidate("connect-base", "connectivity", "C100 HDMI connectivity cable 5m", 75_000), candidate("connect-max", "connectivity", "C300 HDMI connectivity extender 30m", 200_000)]],
    ]);
    const engine = new EvidenceDecisionEngine({ search: vi.fn() } as unknown as EvidenceSearchConnector);
    const result = await engine.decide("rooftop-mission", spec, candidates, false);
    const routerPower = result.assessments.find((item) => item.offerSnapshotId === "power-router")!;
    const suspiciousProjection = result.assessments.find((item) => item.offerSnapshotId === "projection-outlier")!;
    expect(routerPower.hardConstraints.satisfied).toBe(false);
    expect(routerPower.capabilityChecks).toEqual(expect.arrayContaining([expect.objectContaining({ capability: "mission_load_scope", status: "MISMATCH" })]));
    expect(suspiciousProjection.riskFlags).toEqual(expect.arrayContaining(["PRICE_ANOMALY", "VARIANT_AMBIGUOUS"]));
    expect(spec.needs.map((need) => need.label)).toEqual(expect.arrayContaining(["Outdoor projector", "Outdoor projection screen"]));
    const selected = result.portfolios.find((portfolio) => portfolio.type === result.selectedPortfolio)!;
    expect(() => validateMissionPortfolio(spec, selected.itemSnapshotIds, candidates, result.assessments)).not.toThrow();
    expect(selected.itemSnapshotIds).not.toContain("power-router");
    expect(selected.itemSnapshotIds).not.toContain("projection-outlier");
    expect(new Set(result.portfolios.map((portfolio) => portfolio.itemSnapshotIds.join("|"))).size).toBeGreaterThan(1);
    expect(result.portfolios.find((portfolio) => portfolio.type === "BEST_VALUE")?.itemSnapshotIds).not.toEqual(result.portfolios.find((portfolio) => portfolio.type === "CHEAPEST_VALID")?.itemSnapshotIds);
  });
});
