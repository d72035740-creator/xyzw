import { describe, expect, it, vi } from "vitest";
import { OpenAIMissionPlanner } from "./openai-mission-planner";
import type { MissionPlanningInput } from "./planner-types";

const input: MissionPlanningInput = {
  mission: {
    id: "mission",
    version: 2,
    goal: "Birthday",
    budgetAmount: 800000,
    deadline: new Date("2030-01-01T20:00:00+05:30").toISOString(),
    requiredCategories: ["CAKE", "FLOWERS", "RESTAURANT"],
    constraints: { people: 4, vegetarian: true },
  },
  offers: [],
};

describe("OpenAIMissionPlanner", () => {
  it("uses strict structured output and treats merchant content as untrusted data", async () => {
    const output = {
      missionId: "mission",
      missionVersion: 2,
      selectedOffers: [
        {
          offerId: "offer",
          observedOfferVersion: 1,
          category: "CAKE",
          reason: "proposal",
          constraintMapping: { deadline: null, vegetarian: null, people: null },
        },
      ],
      rationale: "proposal only",
      totalAmount: null,
    };
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.store).toBe(false);
      expect(body.text.format).toMatchObject({ type: "json_schema", strict: true });
      expect(body.input[0].content).toContain("untrusted data");
      expect(JSON.stringify(body)).not.toContain("secret-key");
      return new Response(
        JSON.stringify({ output: [{ content: [{ type: "output_text", text: JSON.stringify(output) }] }] }),
        { status: 200 },
      );
    });
    const planner = new OpenAIMissionPlanner({
      apiKey: "test-key-not-secret-key",
      modelId: "configured-test-model",
      fetcher: fetcher as typeof fetch,
    });
    await expect(planner.createPlan(input)).resolves.toEqual(output);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not fake a provider result when configuration is missing", async () => {
    const planner = new OpenAIMissionPlanner({ apiKey: "", modelId: "" });
    await expect(planner.createPlan(input)).rejects.toMatchObject({
      code: "PLANNER_CONFIGURATION_MISSING",
    });
  });
});
