import { beforeEach, describe, expect, it, vi } from "vitest";

const adapter = vi.hoisted(() => ({ searchOffers: vi.fn(), simulateOfferChange: vi.fn() }));

vi.mock("@/commerce/mock-merchant-adapter", () => ({
  mockMerchantAdapter: adapter,
}));

import { POST } from "./route";

const r1 = { id: "r1", code: "R1", amount: 635000, available: true, version: 4 };

describe("demo reset API", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    adapter.searchOffers.mockReset().mockResolvedValue([r1]);
    adapter.simulateOfferChange.mockReset().mockResolvedValue({ offer: { ...r1, amount: 555000, version: 5 } });
  });

  it("allows reset in production only when MISSIONPAY_DEMO_MODE=true", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MISSIONPAY_DEMO_MODE", "true");
    const response = await POST();
    expect(response.status).toBe(200);
    expect(adapter.simulateOfferChange).toHaveBeenCalledWith("r1", 4, { amount: 555000, available: true });
    await expect(response.json()).resolves.toMatchObject({ offer: { amount: 555000 } });
  });

  it("returns 404 in production when demo mode is false or absent", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MISSIONPAY_DEMO_MODE", "false");
    expect((await POST()).status).toBe(404);
    vi.unstubAllEnvs();
    vi.stubEnv("NODE_ENV", "production");
    expect((await POST()).status).toBe(404);
    expect(adapter.searchOffers).not.toHaveBeenCalled();
  });

  it("does not touch a mission, payment record, or committed authority", async () => {
    vi.stubEnv("MISSIONPAY_DEMO_MODE", "true");
    await POST();
    expect(adapter.searchOffers).toHaveBeenCalledWith({ availableOnly: false });
    expect(adapter.simulateOfferChange).toHaveBeenCalledTimes(1);
    // The route delegates solely to the economic offer-change service; it has no mission/payment mutation path.
    expect(adapter.simulateOfferChange.mock.calls[0][2]).toEqual({ amount: 555000, available: true });
  });
});
