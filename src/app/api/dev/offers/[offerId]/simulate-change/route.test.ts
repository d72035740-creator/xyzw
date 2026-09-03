import { describe, expect, it, vi } from "vitest";
import { POST } from "./route";

describe("development-only offer change API", () => {
  it("is inaccessible outside NODE_ENV=development even when the feature flag is set", async () => {
    vi.stubEnv("MISSIONPAY_ENABLE_DEV_WORLD_API", "true");
    const response = await POST(
      new Request("http://localhost/api/dev/offers/test/simulate-change", {
        method: "POST",
        body: JSON.stringify({ expectedOfferVersion: 1, amount: 635000 }),
      }),
      { params: Promise.resolve({ offerId: "test" }) },
    );
    expect(response.status).toBe(404);
    vi.unstubAllEnvs();
  });
});
