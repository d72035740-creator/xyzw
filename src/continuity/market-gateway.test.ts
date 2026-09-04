import { describe, expect, it, vi } from "vitest";
import { MarketGateway, marketQueryFor, SerpApiLocalPlacesConnector, SerpApiShoppingConnector } from "./market-gateway";

const need = { id: "monitor", label: "144Hz monitor", kind: "PRODUCT" as const, quantity: 1, searchQueries: ["untrusted unrelated flowers query"], requiredAttributes: { refreshRateHz: 144 }, dependencies: [] };

describe("SerpApiShoppingConnector", () => {
  it("normalizes only real price-backed shopping results", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ shopping_results: [{ product_id: "p1", title: "Acer 24 inch 144Hz Monitor", source: "Example Store", extracted_price: 12499, product_link: "https://example.test/p1" }, { product_id: "p2", title: "No price", source: "Other Store" }] }), { status: 200 }));
    const offers = await new SerpApiShoppingConnector("test-key", fetcher).search(need, { missionId: "m" });
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ pricePaise: 1_249_900, merchant: { name: "Example Store" }, source: { externalId: "p1", url: "https://example.test/p1" }, attributes: { refreshRateHz: 144 } });
    expect(JSON.stringify(offers)).not.toContain("test-key");
  });

  it("uses the resolved label in query and provider location without inventing delivery evidence", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ shopping_results: [{ product_id: "p1", title: "Acer 144Hz Monitor", source: "Example Store", extracted_price: 12499 }] }), { status: 200 }));
    const connector = new SerpApiShoppingConnector("test-key", fetcher);
    const offers = await connector.search(need, { missionId: "m", locationLabel: "Varanasi, Uttar Pradesh", latitude: 25.3, longitude: 82.9 });
    const requested = new URL(String(fetcher.mock.calls[0][0]));
    expect(requested.searchParams.get("q")).toBe("144Hz monitor delivery Varanasi, Uttar Pradesh India");
    expect(requested.searchParams.get("location")).toBe("Varanasi, Uttar Pradesh");
    expect(offers[0].evidence?.locationCompatibility).toBe("UNKNOWN");
    expect(JSON.stringify(requested)).not.toContain("25.3");
  });

  it("records delivery evidence only when supplied by the source", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ shopping_results: [{ product_id: "p1", title: "Acer 144Hz Monitor", source: "Example Store", extracted_price: 12499, delivery: "Delivery by Monday" }] }), { status: 200 }));
    const [offer] = await new SerpApiShoppingConnector("test-key", fetcher).search(need, { missionId: "m", locationLabel: "Varanasi" });
    expect(offer.evidence).toMatchObject({ locationLabel: "Varanasi", deliveryText: "Delivery by Monday", locationCompatibility: "SUPPORTED_EVIDENCE" });
  });

  it("builds local-service searches without claiming product delivery", () => {
    const restaurant = { ...need, id: "restaurant", kind: "RESTAURANT" as const, label: "Restaurant dinner", searchQueries: ["flowers"] };
    expect(marketQueryFor(restaurant, { missionId: "m", locationLabel: "Delhi" })).toBe("Restaurant dinner Delhi India");
  });

  it("fails explicitly when live mode is missing configuration", async () => {
    await expect(new SerpApiShoppingConnector("").search(need, { missionId: "m" })).rejects.toMatchObject({ code: "LIVE_MARKET_CONFIGURATION_MISSING" });
  });

  it("routes restaurants to Google Maps and leaves non-transactional price evidence unknown", async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ local_results: [{ place_id: "place-1", title: "Varanasi Dining Room", rating: 4.6, reviews: 321, address: "Bhelupur, Varanasi", price: "₹₹", website: "https://restaurant.test" }] }), { status: 200 }));
    const restaurant = { ...need, id: "dining", kind: "RESTAURANT" as const, label: "Restaurant dinner", requiredAttributes: {} };
    const connector = new SerpApiLocalPlacesConnector("test-key", fetcher);
    const [offer] = await connector.search(restaurant, { missionId: "m", locationLabel: "Varanasi" });
    const requested = new URL(String(fetcher.mock.calls[0][0]));
    expect(requested.searchParams.get("engine")).toBe("google_maps");
    expect(requested.searchParams.get("q")).toBe("Restaurant dinner Varanasi India");
    expect(offer).toMatchObject({ title: "Varanasi Dining Room", pricePaise: null, evidence: { rating: 4.6, reviewCount: 321, address: "Bhelupur, Varanasi", priceText: "₹₹", pricingStatus: "UNKNOWN" } });
    const [result] = await new MarketGateway("live", [connector]).search([restaurant], { missionId: "m", locationLabel: "Varanasi" });
    expect(result.error).toMatchObject({ code: "INSUFFICIENT_PRICING_EVIDENCE" });
  });

  it("returns NO_SUPPORTED_MARKET_SOURCE instead of substituting another category", async () => {
    const travel = { ...need, id: "travel", kind: "TRAVEL" as const, label: "Train ticket" };
    await expect(new MarketGateway("live", []).search([travel], { missionId: "m", locationLabel: "Varanasi" })).rejects.toMatchObject({ code: "NO_SUPPORTED_MARKET_SOURCE" });
  });
});
