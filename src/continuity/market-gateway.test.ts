import { describe, expect, it, vi } from "vitest";
import { extractListingCapabilities, MarketGateway, marketQueryFor, parseShoppingPricePaise, SerpApiLocalPlacesConnector, SerpApiShoppingConnector, SerperPlacesConnector, SerperShoppingConnector } from "./market-gateway";

const need = { id: "monitor", label: "144Hz monitor", kind: "PRODUCT" as const, quantity: 1, searchQueries: ["untrusted unrelated flowers query"], requiredAttributes: { refreshRateHz: 144 }, dependencies: [] };

describe("SerpApiShoppingConnector", () => {
  it.each([["₹1,299", 129_900], ["₹ 1,299", 129_900], ["Rs. 1,299", 129_900], ["INR 1299", 129_900], ["1,299", 129_900]])("parses an exact Indian Shopping price: %s", (price, expected) => {
    expect(parseShoppingPricePaise(price)).toBe(expected);
  });

  it("rejects Shopping price ranges and malformed values", () => {
    expect(parseShoppingPricePaise("₹1,299 - ₹1,999")).toBeNull();
    expect(parseShoppingPricePaise("starting at ₹1,299")).toBeNull();
    expect(parseShoppingPricePaise("price on request")).toBeNull();
  });
  it("extracts generic rated and system capabilities from listing evidence", () => {
    expect(extractListingCapabilities("Powered outdoor audio system 400 Watts IP65")).toMatchObject({ complete_system: true, outdoor_suitability: true, water_resistance: true, rated_w: 400 });
    expect(extractListingCapabilities("12V 2A mini UPS power backup for router")).not.toHaveProperty("rated_power_output");
  });

  it("normalizes only real price-backed shopping results", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ shopping_results: [{ product_id: "p1", title: "Acer 24 inch 144Hz Monitor", source: "Example Store", extracted_price: 12499, product_link: "https://example.test/p1" }, { product_id: "p2", title: "No price", source: "Other Store" }] }), { status: 200 }));
    const offers = await new SerpApiShoppingConnector("test-key", fetcher).search(need, { missionId: "m" });
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ pricePaise: 1_249_900, merchant: { name: "Example Store" }, source: { externalId: "p1", url: "https://example.test/p1" }, attributes: { refreshRateHz: 144 } });
    expect(JSON.stringify(offers)).not.toContain("test-key");
  });

  it("normalizes Serper Shopping prices into the existing offer shape", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ shopping: [{ productId: "serper-1", title: "Mechanical Gaming Keyboard", source: "Example Store", price: "₹1,299", link: "https://example.test/keyboard", rating: 4.5, ratingCount: 42 }] }), { status: 200 }));
    const [offer] = await new SerperShoppingConnector("serper-key", fetcher).search({ ...need, id: "keyboard", label: "Mechanical keyboard", requiredAttributes: { mechanical: true } }, { missionId: "m" });
    expect(offer).toMatchObject({ pricePaise: 129_900, source: { provider: "serper-google-shopping", externalId: "serper-1", url: "https://example.test/keyboard" }, attributes: { mechanical: true } });
    expect(JSON.stringify(offer)).not.toContain("serper-key");
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

  it("routes restaurants through Serper Places without fabricating a price", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ places: [{ placeId: "place-1", title: "Varanasi Vegetarian Kitchen", address: "Bhelupur, Varanasi", rating: 4.7, ratingCount: 421, category: "Vegetarian restaurant", website: "https://restaurant.test" }] }), { status: 200 }));
    const restaurant = { ...need, id: "dining", kind: "RESTAURANT" as const, label: "Vegetarian dinner", requiredAttributes: {} };
    const [offer] = await new SerperPlacesConnector("serper-key", fetcher).search(restaurant, { missionId: "m", locationLabel: "Varanasi" });
    expect(fetcher.mock.calls[0][0]).toBe("https://google.serper.dev/places");
    expect(offer).toMatchObject({ pricePaise: null, source: { provider: "serper-places", externalId: "place-1" }, evidence: { pricingStatus: "UNKNOWN", rating: 4.7, reviewCount: 421 } });
  });

  it("returns NO_SUPPORTED_MARKET_SOURCE instead of substituting another category", async () => {
    const travel = { ...need, id: "travel", kind: "TRAVEL" as const, label: "Train ticket" };
    await expect(new MarketGateway("live", []).search([travel], { missionId: "m", locationLabel: "Varanasi" })).rejects.toMatchObject({ code: "NO_SUPPORTED_MARKET_SOURCE" });
  });

  it("runs one generic refined Shopping query when a product has no exact price", async () => {
    const connector = { connectorId: "test-shopping", supports: () => true, search: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "fallback", needId: need.id, source: { provider: "test-shopping", externalId: "fallback" }, merchant: { name: "Store" }, title: "144Hz monitor", pricePaise: 1_000_000, currency: "INR", availability: "UNKNOWN", observedAt: new Date().toISOString(), sourceVersion: "v1", attributes: { refreshRateHz: 144 }, evidence: { title: "listing", pricingStatus: "KNOWN" }, reversibility: { type: "UNKNOWN" } }]) };
    const [result] = await new MarketGateway("live", [connector]).search([need], { missionId: "m" });
    expect(result.offers).toHaveLength(1);
    expect(connector.search).toHaveBeenCalledTimes(2);
    expect(connector.search.mock.calls[1][0].label).toContain("buy online price India");
  });
});
