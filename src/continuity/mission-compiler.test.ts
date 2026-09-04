import { afterEach, describe, expect, it, vi } from "vitest";
import { MissionCompiler } from "./mission-compiler";
import { missionLocationInputSchema } from "./types";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("MissionCompiler", () => {
  it("builds dynamic gaming needs without granting financial authority", async () => {
    vi.stubEnv("MISSIONPAY_PLANNER_PROVIDER", "mock");
    const spec = await new MissionCompiler().compile({ goal: "Build me a gaming setup under ₹55,000 with a 144Hz monitor, mechanical keyboard, wireless mouse and ergonomic chair", maximumAuthorityPaise: 5_500_000, repairAllowancePaise: 100_000 });
    expect(spec.needs).toHaveLength(4);
    expect(spec.needs.map((need) => need.label)).toEqual(expect.arrayContaining([expect.stringContaining("monitor"), expect.stringContaining("keyboard"), expect.stringContaining("mouse"), expect.stringContaining("chair")]));
    expect(spec.budgetPaise).toBe(5_500_000);
    expect(spec.repairAuthority.maxAdditionalSpendPaise).toBe(100_000);
  });

  it("rejects a mismatch between natural language and explicit authority", async () => {
    vi.stubEnv("MISSIONPAY_PLANNER_PROVIDER", "mock");
    await expect(new MissionCompiler().compile({ goal: "Buy a setup under ₹50,000", maximumAuthorityPaise: 6_000_000 })).rejects.toMatchObject({ code: "BUDGET_CONSTRAINT_MISMATCH" });
  });

  it("places browser-approved location in MissionSpec", async () => {
    vi.stubEnv("MISSIONPAY_PLANNER_PROVIDER", "mock");
    const spec = await new MissionCompiler().compile({ goal: "Buy a monitor under ₹20,000", maximumAuthorityPaise: 2_000_000, location: { browser: { source: "browser", label: "Varanasi, Uttar Pradesh", latitude: 25.3176, longitude: 82.9739, accuracyMeters: 120 } } });
    expect(spec.location).toEqual({ source: "browser", label: "Varanasi, Uttar Pradesh", latitude: 25.3176, longitude: 82.9739, accuracyMeters: 120 });
  });

  it("manual location overrides browser location", async () => {
    vi.stubEnv("MISSIONPAY_PLANNER_PROVIDER", "mock");
    const spec = await new MissionCompiler().compile({ goal: "Buy a monitor under ₹20,000", maximumAuthorityPaise: 2_000_000, location: { manualLabel: "Bengaluru", browser: { source: "browser", label: "Varanasi", latitude: 25.3, longitude: 82.9 } } });
    expect(spec.location).toEqual({ source: "manual", label: "Bengaluru" });
  });

  it("an explicit prompt delivery target overrides manual and browser location", async () => {
    vi.stubEnv("MISSIONPAY_PLANNER_PROVIDER", "mock");
    const spec = await new MissionCompiler().compile({ goal: "Buy a monitor for delivery in Delhi under ₹20,000", maximumAuthorityPaise: 2_000_000, location: { manualLabel: "Bengaluru", browser: { source: "browser", label: "Varanasi", latitude: 25.3, longitude: 82.9 } } });
    expect(spec.location).toEqual({ source: "prompt", label: "Delhi" });
  });

  it("works without browser permission and location cannot change authority", async () => {
    vi.stubEnv("MISSIONPAY_PLANNER_PROVIDER", "mock");
    const spec = await new MissionCompiler().compile({ goal: "Buy a monitor under ₹20,000", maximumAuthorityPaise: 2_000_000 });
    expect(spec.location).toBeUndefined();
    expect(spec.budgetPaise).toBe(2_000_000);
    expect(missionLocationInputSchema.safeParse({ manualLabel: "Delhi", maximumAuthorityPaise: 9_999_999 }).success).toBe(false);
  });

  it.each([
    ["Plan dinner with my girlfriend in Varanasi under ₹5,000", "RESTAURANT", "Restaurant dinner", "partner", "Varanasi"],
    ["Buy flowers for my girlfriend under ₹1,000", "PRODUCT", "Flowers", "partner", undefined],
    ["Get my parents a television under ₹30,000", "PRODUCT", "Television", "parents", undefined],
    ["Plan my friend's birthday dinner under ₹5,000", "RESTAURANT", "Restaurant dinner", "friend", undefined],
    ["Buy a birthday cake for my friend under ₹2,000", "PRODUCT", "Birthday cake", "friend", undefined],
  ])("keeps participants out of commerce needs: %s", async (goal, kind, label, participant, location) => {
    vi.stubEnv("MISSIONPAY_PLANNER_PROVIDER", "mock");
    const spec = await new MissionCompiler().compile({ goal });
    expect(spec.needs).toEqual([expect.objectContaining({ kind, label })]);
    expect(spec.participants).toContainEqual(expect.objectContaining({ label: participant }));
    expect(spec.needs.map((item) => item.label.toLowerCase()).join(" ")).not.toMatch(/girlfriend|parents|friend/);
    expect(spec.location?.label).toBe(location);
  });

  it("rejects a context-only AI need before it can reach market search", async () => {
    vi.stubEnv("MISSIONPAY_PLANNER_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("OPENAI_PLANNER_MODEL", "test-model");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ output_text: JSON.stringify({
      goal: "Dinner with your partner", budgetPaise: 500000, currency: "INR",
      participants: [{ label: "partner", count: 2, role: "participant" }],
      needs: [{ id: "bad", label: "girlfriend", kind: "PRODUCT", quantity: 1, searchQueries: ["flowers"], requiredAttributes: [], dependencies: [] }],
      globalConstraints: [], outcome: { requiredNeedIds: ["bad"], predicates: [] },
      repairAuthority: { allowAutomaticSubstitution: true, maxAdditionalSpendPaise: 0 },
    }) }), { status: 200 })));
    await expect(new MissionCompiler().compile({ goal: "Plan dinner with my girlfriend under ₹5,000" })).rejects.toMatchObject({ code: "INVALID_MISSION_NEED" });
  });

  it("rejects an AI-inferred flower purchase that the user never requested", async () => {
    vi.stubEnv("MISSIONPAY_PLANNER_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("OPENAI_PLANNER_MODEL", "test-model");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ output_text: JSON.stringify({
      goal: "Dinner with your partner", budgetPaise: 500000, currency: "INR",
      participants: [{ label: "partner", count: 2, role: "participant" }],
      needs: [{ id: "flowers", label: "Flowers", kind: "PRODUCT", quantity: 1, searchQueries: ["flowers"], requiredAttributes: [], dependencies: [] }],
      globalConstraints: [], outcome: { requiredNeedIds: ["flowers"], predicates: [] },
      repairAuthority: { allowAutomaticSubstitution: true, maxAdditionalSpendPaise: 0 },
    }) }), { status: 200 })));
    await expect(new MissionCompiler().compile({ goal: "Plan dinner with my girlfriend under ₹5,000" })).rejects.toMatchObject({ code: "INVALID_MISSION_NEED", details: { reason: "UNREQUESTED_COMMERCE_CATEGORY" } });
  });
});
