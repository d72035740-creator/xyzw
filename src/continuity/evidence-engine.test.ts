import { describe, expect, it, vi } from "vitest";
import { EvidenceDecisionEngine, EvidenceSearchConnector, inferDecisionProfile, optimizePortfolios, productIdentity, type CandidateAssessment } from "./evidence-engine";

function assessment(offerSnapshotId: string, needId: string, price: number, utility: number): CandidateAssessment {
  return { offerSnapshotId, needId, title: offerSnapshotId, currentPricePaise: price, identity: {}, identityConfidence: "MEDIUM", hardConstraints: { satisfied: true, failures: [], unknowns: [] }, scores: { requirementFit: 100, productQuality: utility, communityReliability: 50, evidenceConfidence: 60, priceEfficiency: 70, utility }, evidenceCounts: { officialSources: 1, professionalSources: 1, communityDiscussions: 1, merchantSources: 1 }, recurringPositives: [], recurringNegatives: [], riskFlags: [] };
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
});
