import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContinuityError } from "@/continuity/types";

const mockContinuityService = vi.hoisted(() => ({
  understand: vi.fn(),
  build: vi.fn(),
}));

vi.mock("@/continuity/continuity-service", () => ({
  continuityService: mockContinuityService,
}));

import { POST as marketPOST } from "./route";

describe("POST /api/continuity/missions/[missionId]/market", () => {
  const missionId = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes market search for persisted mission and returns 200 without precise location", async () => {
    const mockView = {
      mission: { id: missionId, status: "READY_TO_COMMIT", version: 2 },
      spec: {
        goal: "Build a gaming setup",
        location: {
          source: "browser",
          label: "Varanasi, UP",
          latitude: 25.3176,
          longitude: 82.9739,
        },
        needs: [{ id: "n1", label: "Monitor" }],
      },
      selections: [{ id: "s1", needId: "n1", title: "144Hz Monitor" }],
    };

    mockContinuityService.build.mockResolvedValueOnce(mockView);

    const request = new Request(`http://localhost/api/continuity/missions/${missionId}/market`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ missionVersion: 1 }),
    });

    const response = await marketPOST(request, { params: Promise.resolve({ missionId }) });
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(mockContinuityService.build).toHaveBeenCalledTimes(1);
    expect(mockContinuityService.build).toHaveBeenCalledWith({ missionId, missionVersion: 1 });

    // Assert results returned
    expect(data.mission.id).toBe(missionId);
    expect(data.selections).toHaveLength(1);
    // Assert precise coordinates stripped
    expect(data.spec.location).toEqual({ source: "browser", label: "Varanasi, UP" });
  });

  it("accepts expectedVersion as an alias for missionVersion", async () => {
    mockContinuityService.build.mockResolvedValueOnce({
      mission: { id: missionId, status: "READY_TO_COMMIT", version: 2 },
      spec: { goal: "Office desk" },
    });

    const request = new Request(`http://localhost/api/continuity/missions/${missionId}/market`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1 }),
    });

    const response = await marketPOST(request, { params: Promise.resolve({ missionId }) });
    expect(response.status).toBe(200);
    expect(mockContinuityService.build).toHaveBeenCalledWith({ missionId, missionVersion: 1 });
  });

  it("rejects when missionId in body does not match route param", async () => {
    const request = new Request(`http://localhost/api/continuity/missions/${missionId}/market`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        missionId: "22222222-2222-4222-8222-222222222222",
        missionVersion: 1,
      }),
    });

    const response = await marketPOST(request, { params: Promise.resolve({ missionId }) });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("INVALID_REQUEST");
    expect(mockContinuityService.build).not.toHaveBeenCalled();
  });

  it("returns 409 STALE_PLAN and logs structured error code when mission version conflicts", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockContinuityService.build.mockRejectedValueOnce(
      new ContinuityError("STALE_PLAN", "Mission version is stale", 409)
    );

    const request = new Request(`http://localhost/api/continuity/missions/${missionId}/market`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ missionVersion: 1 }),
    });

    const response = await marketPOST(request, { params: Promise.resolve({ missionId }) });
    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.error.code).toBe("STALE_PLAN");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[CONTINUITY_ERROR] status=409 code=STALE_PLAN message=Mission version is stale"),
      expect.objectContaining({ code: "STALE_PLAN", status: 409 })
    );

    consoleSpy.mockRestore();
  });

  it("returns 409 MARKET_SEARCH_NOT_ALLOWED and logs structured error code when mission is not in PLANNING status", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockContinuityService.build.mockRejectedValueOnce(
      new ContinuityError("MARKET_SEARCH_NOT_ALLOWED", "Mission is not awaiting market search", 409)
    );

    const request = new Request(`http://localhost/api/continuity/missions/${missionId}/market`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ missionVersion: 1 }),
    });

    const response = await marketPOST(request, { params: Promise.resolve({ missionId }) });
    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.error.code).toBe("MARKET_SEARCH_NOT_ALLOWED");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[CONTINUITY_ERROR] status=409 code=MARKET_SEARCH_NOT_ALLOWED"),
      expect.objectContaining({ code: "MARKET_SEARCH_NOT_ALLOWED", status: 409 })
    );

    consoleSpy.mockRestore();
  });

  it("regresses full understanding -> market flow without second mission creation", async () => {
    // 1. UNDERSTAND MY MISSION
    const understood = {
      missionId,
      missionVersion: 1,
      spec: {
        goal: "Gaming setup under 55k",
        budgetPaise: 5500000,
        currency: "INR",
        needs: [
          { id: "need_mon", label: "144Hz Monitor", kind: "PRODUCT" },
          { id: "need_kb", label: "Mechanical Keyboard", kind: "PRODUCT" },
        ],
      },
    };
    mockContinuityService.understand.mockResolvedValueOnce(understood);

    const understandResult = await mockContinuityService.understand({ goal: "Gaming setup" });
    // 2. Assert one mission persisted
    expect(understandResult.missionId).toBe(missionId);
    expect(understandResult.missionVersion).toBe(1);

    // 3. SEARCH LIVE MARKET is triggered
    // 4. Assert NO second POST creating mission (understand is NOT called again)
    mockContinuityService.build.mockResolvedValueOnce({
      mission: { id: missionId, status: "READY_TO_COMMIT", version: 2 },
      spec: understandResult.spec,
      selections: [
        { id: "sel_1", needId: "need_mon", title: "LG 144Hz IPS Monitor", pricePaise: 1200000 },
        { id: "sel_2", needId: "need_kb", title: "Keychron K2 Keyboard", pricePaise: 650000 },
      ],
    });

    // 5. Assert existing missionId/version used on the dedicated market route
    const marketRequest = new Request(
      `http://localhost/api/continuity/missions/${understandResult.missionId}/market`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ missionVersion: understandResult.missionVersion }),
      }
    );

    const marketResponse = await marketPOST(marketRequest, {
      params: Promise.resolve({ missionId: understandResult.missionId }),
    });

    // 6. Assert market search actually invoked
    expect(mockContinuityService.understand).toHaveBeenCalledTimes(1); // compile once
    expect(mockContinuityService.build).toHaveBeenCalledTimes(1); // market search once on persisted mission
    expect(mockContinuityService.build).toHaveBeenCalledWith({
      missionId,
      missionVersion: 1,
    });

    // 7. No 409
    expect(marketResponse.status).toBe(200);

    // 8. Results returned
    const result = await marketResponse.json();
    expect(result.mission.id).toBe(missionId);
    expect(result.selections).toHaveLength(2);
    expect(result.selections[0].title).toBe("LG 144Hz IPS Monitor");
  });
});
