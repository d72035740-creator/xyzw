import { afterEach, describe, expect, it, vi } from "vitest";
import { MissionCompiler } from "./mission-compiler";
import { missionLocationInputSchema } from "./types";

afterEach(() => vi.unstubAllEnvs());

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
});
