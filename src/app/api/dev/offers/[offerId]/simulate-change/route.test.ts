import { describe, expect, it, vi } from "vitest";
import { POST } from "./route";

describe("demo-mode offer change API", () => {
  it("is inaccessible in production when demo mode is absent", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MISSIONPAY_DEMO_MODE", "false");
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
