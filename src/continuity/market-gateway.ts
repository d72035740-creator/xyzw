import { createHash, randomUUID } from "node:crypto";
import type { MarketOffer, MissionNeed } from "./types";
import { ContinuityError } from "./types";

export type MarketSearchContext = { missionId: string; locationLabel?: string; latitude?: number; longitude?: number };
export interface MarketConnector {
  readonly connectorId: string;
  supports(need: MissionNeed): boolean;
  search(need: MissionNeed, context: MarketSearchContext): Promise<MarketOffer[]>;
  revalidate?(offer: MarketOffer, need: MissionNeed, context: MarketSearchContext): Promise<MarketOffer | null>;
}

const version = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

export function hasKnownPrice(offer: MarketOffer): offer is MarketOffer & { pricePaise: number } {
  return typeof offer.pricePaise === "number" && Number.isInteger(offer.pricePaise) && offer.pricePaise > 0;
}

export function marketQueryFor(need: MissionNeed, context: MarketSearchContext) {
  const base = need.label.trim();
  const location = context.locationLabel?.trim();
  if (!location || base.toLowerCase().includes(location.toLowerCase())) return base;
  const country = /\bindia\b/i.test(location) ? "" : " India";
  const qualifier = need.kind === "PRODUCT" || need.kind === "OTHER_COMMERCE" ? "delivery " : "";
  return `${base} ${qualifier}${location}${country}`.replace(/\s+/g, " ").trim();
}

type SerpShoppingResult = {
  product_id?: string; title?: string; source?: string; extracted_price?: number;
  product_link?: string; link?: string; snippet?: string; delivery?: string;
};

export class SerpApiShoppingConnector implements MarketConnector {
  readonly connectorId = "serpapi-google-shopping";
  constructor(private readonly apiKey = process.env.SERPAPI_API_KEY ?? "", private readonly fetcher: typeof fetch = fetch) {}
  supports(need: MissionNeed) { return need.kind === "PRODUCT" || need.kind === "OTHER_COMMERCE"; }

  async search(need: MissionNeed, context: MarketSearchContext) {
    if (!this.apiKey) throw new ContinuityError("LIVE_MARKET_CONFIGURATION_MISSING", "SERPAPI_API_KEY is required in live market mode", 503);
    const query = marketQueryFor(need, context);
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google_shopping");
    url.searchParams.set("q", query);
    url.searchParams.set("gl", "in");
    url.searchParams.set("hl", "en");
    url.searchParams.set("api_key", this.apiKey);
    if (context.locationLabel) url.searchParams.set("location", context.locationLabel);
    const response = await this.fetcher(url, { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new ContinuityError("LIVE_MARKET_PROVIDER_FAILED", "Live shopping search failed", 502, { providerStatus: response.status });
    const body = await response.json() as { shopping_results?: SerpShoppingResult[] };
    return (body.shopping_results ?? []).flatMap((item, index): MarketOffer[] => {
      if (!item.title || !item.source || !Number.isFinite(item.extracted_price) || item.extracted_price! <= 0) return [];
      const pricePaise = Math.round(item.extracted_price! * 100);
      const externalId = item.product_id ?? `${query}-${index}`;
      const observedAt = new Date().toISOString();
      const sourceUrl = item.product_link ?? item.link;
      const deliverySupported = Boolean(item.delivery && context.locationLabel && !/\b(?:not available|unavailable|cannot|can't|no delivery)\b/i.test(item.delivery));
      const lower = item.title.toLowerCase();
      const attributes: Record<string, unknown> = { extraction: "listing-title-evidence", delivery: item.delivery ?? null, locationCompatibility: deliverySupported ? "SUPPORTED_EVIDENCE" : "UNKNOWN" };
      for (const [key, expected] of Object.entries(need.requiredAttributes)) {
        if (key === "refreshRateHz") { const hz = lower.match(/(\d{2,3})\s*hz/); if (hz) attributes[key] = Number(hz[1]); }
        else if (typeof expected === "boolean" && expected && lower.includes(key.toLowerCase())) attributes[key] = true;
        else if (typeof expected === "string" && lower.includes(expected.toLowerCase())) attributes[key] = expected;
      }
      return [{
        id: randomUUID(), needId: need.id, source: { provider: this.connectorId, externalId, url: sourceUrl },
        merchant: { name: item.source }, title: item.title, description: item.snippet, pricePaise, currency: "INR",
        availability: "UNKNOWN", observedAt, sourceVersion: version([externalId, pricePaise, item.source, item.title, observedAt]), attributes,
        evidence: { title: item.title, snippet: item.snippet, sourceUrl, locationLabel: context.locationLabel, deliveryText: item.delivery, locationCompatibility: deliverySupported ? "SUPPORTED_EVIDENCE" : "UNKNOWN", pricingStatus: "KNOWN" },
        reversibility: { type: "UNKNOWN" },
      }];
    }).slice(0, 8);
  }

  async revalidate(offer: MarketOffer, need: MissionNeed, context: MarketSearchContext) {
    const results = await this.search(need, context);
    return results.find((candidate) => candidate.source.externalId === offer.source.externalId) ?? null;
  }
}

type SerpLocalResult = {
  place_id?: string; data_id?: string; title?: string; rating?: number; reviews?: number; address?: string;
  price?: string; type?: string; description?: string; website?: string; place_id_search?: string;
};

export class SerpApiLocalPlacesConnector implements MarketConnector {
  readonly connectorId = "serpapi-google-maps";
  constructor(private readonly apiKey = process.env.SERPAPI_API_KEY ?? "", private readonly fetcher: typeof fetch = fetch) {}
  supports(need: MissionNeed) { return need.kind === "RESTAURANT" || need.kind === "LOCAL_SERVICE"; }

  async search(need: MissionNeed, context: MarketSearchContext) {
    if (!this.apiKey) throw new ContinuityError("LIVE_MARKET_CONFIGURATION_MISSING", "SERPAPI_API_KEY is required in live market mode", 503);
    if (!context.locationLabel) throw new ContinuityError("NO_SUPPORTED_MARKET_SOURCE", `${need.label} requires a target location for local search`, 422, { needId: need.id });
    const query = marketQueryFor(need, context);
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google_maps");
    url.searchParams.set("type", "search");
    url.searchParams.set("q", query);
    url.searchParams.set("hl", "en");
    url.searchParams.set("api_key", this.apiKey);
    if (context.latitude !== undefined && context.longitude !== undefined) url.searchParams.set("ll", `@${context.latitude},${context.longitude},14z`);
    const response = await this.fetcher(url, { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new ContinuityError("LIVE_MARKET_PROVIDER_FAILED", "Live local search failed", 502, { providerStatus: response.status });
    const body = await response.json() as { local_results?: SerpLocalResult[] };
    return (body.local_results ?? []).flatMap((item, index): MarketOffer[] => {
      if (!item.title) return [];
      const externalId = item.place_id ?? item.data_id ?? `${query}-${index}`;
      const observedAt = new Date().toISOString();
      const sourceUrl = item.website ?? item.place_id_search;
      return [{
        id: randomUUID(), needId: need.id, source: { provider: this.connectorId, externalId, url: sourceUrl },
        merchant: { name: item.title, location: item.address }, title: item.title, description: item.description,
        pricePaise: null, currency: "INR", availability: "UNKNOWN", observedAt,
        sourceVersion: version([externalId, item.title, item.rating, item.reviews, item.address, item.price, observedAt]),
        attributes: { type: item.type ?? null, rating: item.rating ?? null, reviewCount: item.reviews ?? null, address: item.address ?? null },
        evidence: { title: item.title, snippet: item.description, sourceUrl, locationLabel: context.locationLabel, locationCompatibility: "SUPPORTED_EVIDENCE", rating: item.rating, reviewCount: item.reviews, address: item.address, priceText: item.price, pricingStatus: "UNKNOWN" },
        reversibility: { type: "UNKNOWN" },
      }];
    }).slice(0, 8);
  }

  async revalidate(offer: MarketOffer, need: MissionNeed, context: MarketSearchContext) {
    const results = await this.search(need, context);
    return results.find((candidate) => candidate.source.externalId === offer.source.externalId) ?? null;
  }
}

export class SandboxShoppingConnector implements MarketConnector {
  readonly connectorId = "missionpay-sandbox";
  supports() { return true; }
  async search(need: MissionNeed) {
    const seed = [...need.id].reduce((sum, character) => sum + character.charCodeAt(0), 0);
    const base = 250000 + (seed % 9000) * 10;
    return [0, 1, 2].map((index): MarketOffer => ({
      id: randomUUID(), needId: need.id, source: { provider: this.connectorId, externalId: `${need.id}-${index + 1}` },
      merchant: { name: `Sandbox Merchant ${index + 1}` }, title: `${need.label} — Sandbox option ${index + 1}`,
      pricePaise: base + index * 45000, currency: "INR", availability: "AVAILABLE", observedAt: new Date().toISOString(),
      sourceVersion: version([need.id, index, base]), attributes: { ...need.requiredAttributes, synthetic: true },
      evidence: { title: "Synthetic sandbox listing", pricingStatus: "KNOWN" }, reversibility: { type: "UNKNOWN" },
    }));
  }
  async revalidate(offer: MarketOffer) { return { ...offer, observedAt: new Date().toISOString() }; }
}

export type MarketSearchResult = { need: MissionNeed; connectorId: string | null; query: string; offers: MarketOffer[]; error?: ContinuityError };

export class MarketGateway {
  readonly mode: "live" | "sandbox";
  private readonly connectors: MarketConnector[];

  constructor(mode = (process.env.MISSIONPAY_MARKET_MODE ?? "sandbox") as "live" | "sandbox", connectors?: MarketConnector[]) {
    this.mode = mode;
    this.connectors = connectors ?? (mode === "live" ? [new SerpApiShoppingConnector(), new SerpApiLocalPlacesConnector()] : [new SandboxShoppingConnector()]);
  }

  private connectorFor(need: MissionNeed) { return this.connectors.find((connector) => connector.supports(need)); }

  async search(needs: MissionNeed[], context: MarketSearchContext): Promise<MarketSearchResult[]> {
    const results = await Promise.all(needs.map(async (need): Promise<MarketSearchResult> => {
      const query = marketQueryFor(need, context);
      const connector = this.connectorFor(need);
      if (!connector) return { need, connectorId: null, query, offers: [], error: new ContinuityError("NO_SUPPORTED_MARKET_SOURCE", `No supported market source exists for ${need.label}`, 422, { needId: need.id, kind: need.kind }) };
      try {
        const offers = await connector.search(need, context);
        if (!offers.length) return { need, connectorId: connector.connectorId, query, offers, error: new ContinuityError("NO_SUPPORTED_MARKET_SOURCE", `No supported market results found for ${need.label}`, 409, { needId: need.id }) };
        if (!offers.some(hasKnownPrice)) return { need, connectorId: connector.connectorId, query, offers, error: new ContinuityError("INSUFFICIENT_PRICING_EVIDENCE", `No exact transaction price is available for ${need.label}`, 409, { needId: need.id }) };
        return { need, connectorId: connector.connectorId, query, offers };
      } catch (error) {
        return { need, connectorId: connector.connectorId, query, offers: [], error: error instanceof ContinuityError ? error : new ContinuityError("MARKET_SEARCH_FAILED", "Market search failed", 502) };
      }
    }));
    if (results.every((result) => result.offers.length === 0)) throw results.find((result) => result.error)?.error;
    return results;
  }

  async revalidate(offer: MarketOffer, need: MissionNeed, context: MarketSearchContext) {
    const connector = this.connectors.find((candidate) => candidate.connectorId === offer.source.provider) ?? this.connectorFor(need);
    return connector?.revalidate?.(offer, need, context) ?? null;
  }
}
