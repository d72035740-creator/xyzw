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
const SHOPPING_TIMEOUT_MS = 3_500;

async function boundedMap<T, R>(values: T[], concurrency: number, action: (value: T) => Promise<R>) {
  const results: R[] = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await action(values[index]);
    }
  }));
  return results;
}

function marketDiagnostic(event: string, data: Record<string, unknown>) { console.info(event, data); }

export function hasKnownPrice(offer: MarketOffer): offer is MarketOffer & { pricePaise: number } {
  return typeof offer.pricePaise === "number" && Number.isInteger(offer.pricePaise) && offer.pricePaise > 0;
}

export function extractListingCapabilities(title: string, description = "") {
  const text = `${title} ${description}`;
  const capabilities: Record<string, unknown> = {};
  if (/\b(?:outdoor|weatherproof|waterproof|ip\d{2})\b/i.test(text)) capabilities.outdoor_suitability = true;
  if (/\b(?:weatherproof|waterproof|ip\d{2})\b/i.test(text)) capabilities.water_resistance = true;
  if (/\b(?:portable|foldable|carry)\b/i.test(text)) capabilities.portable = true;
  if (/\b(?:wireless|wi-?fi|bluetooth)\b/i.test(text)) capabilities.wireless = true;
  if (/\b(?:powered|active|built[- ]in amplifier|integrated amplifier|all[- ]in[- ]one|party speaker|bluetooth speaker)\b/i.test(text)) capabilities.complete_system = true;
  else if (/\bpassive\b/i.test(text) || (/\b(?:wall|ceiling)[-/ ]mounted speakers?\b/i.test(text) && !/\b(?:powered|active)\b/i.test(text))) capabilities.complete_system = false;
  const unitPattern = /(\d+(?:\.\d+)?)\s*(hz|w|watts?|va|wh|ah|lumens?|lm|inches?|inch|cm|m)\b/gi;
  const names: Record<string, string> = { watt: "w", watts: "w", w: "w", va: "va", wh: "wh", ah: "ah", hz: "hz", lumen: "lm", lumens: "lm", lm: "lm", inch: "in", inches: "in", cm: "cm", m: "m" };
  for (const match of text.matchAll(unitPattern)) {
    const key = `rated_${names[match[2].toLowerCase()] ?? match[2].toLowerCase()}`;
    capabilities[key] = Math.max(typeof capabilities[key] === "number" ? capabilities[key] as number : 0, Number(match[1]));
  }
  const interfaces = [["HDMI", /\bhdmi\b/i], ["USB", /\busb(?:-c)?\b/i], ["BLUETOOTH", /\bbluetooth\b/i], ["WIFI", /\bwi-?fi\b/i], ["RJ45", /\brj-?45\b/i], ["3.5MM", /\b3\.5\s*mm\b/i]].filter(([, pattern]) => (pattern as RegExp).test(text)).map(([name]) => name as string);
  if (interfaces.length) capabilities.interfaces = interfaces;
  return capabilities;
}

export function marketQueryFor(need: MissionNeed, context: MarketSearchContext) {
  const base = need.label.trim();
  const location = context.locationLabel?.trim();
  if (!location || base.toLowerCase().includes(location.toLowerCase())) return base;
  const country = /\bindia\b/i.test(location) ? "" : " India";
  const qualifier = need.kind === "PRODUCT" || need.kind === "OTHER_COMMERCE" ? "delivery " : "";
  return `${base} ${qualifier}${location}${country}`.replace(/\s+/g, " ").trim();
}

function refinedShoppingNeed(need: MissionNeed): MissionNeed {
  const constraints = Object.entries(need.requiredAttributes).map(([key, value]) => `${key} ${String(value)}`).join(" ");
  return { ...need, label: `${need.label} buy online price India${constraints ? ` ${constraints}` : ""}` };
}

type SerpShoppingResult = {
  product_id?: string; title?: string; source?: string; extracted_price?: number | string; price?: string;
  product_link?: string; link?: string; snippet?: string; delivery?: string;
};

export function parseShoppingPricePaise(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : null;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || /(?:-|–|—|to)\s*(?:₹|rs\.?|inr)?\s*\d/i.test(normalized) || /(?:starting|from)\s+(?:₹|rs\.?|inr)?\s*\d/i.test(normalized)) return null;
  const match = normalized.match(/^(?:₹\s*|rs\.?\s*|inr\s*)?(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d{1,2})?$/i);
  if (!match) return null;
  const rupees = Number(match[1].replaceAll(",", ""));
  return Number.isFinite(rupees) && rupees > 0 && rupees < 10_000_000 ? Math.round(rupees * 100) : null;
}

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
    const startedAt = Date.now();
    let response: Response;
    try { response = await this.fetcher(url, { signal: AbortSignal.timeout(SHOPPING_TIMEOUT_MS) }); }
    catch (error) { marketDiagnostic("SHOPPING_REQUEST_END", { provider: this.connectorId, elapsedMs: Date.now() - startedAt, error: error instanceof Error ? error.name : "request_failed" }); throw error; }
    marketDiagnostic("SHOPPING_REQUEST_END", { provider: this.connectorId, httpStatus: response.status, elapsedMs: Date.now() - startedAt });
    if (!response.ok) throw new ContinuityError("LIVE_MARKET_PROVIDER_FAILED", "Live shopping search failed", 502, { providerStatus: response.status });
    const body = await response.json() as { shopping_results?: SerpShoppingResult[] };
    const shoppingResults = body.shopping_results ?? [];
    let rejectedPrice = 0;
    const offers = shoppingResults.flatMap((item, index): MarketOffer[] => {
      const pricePaise = parseShoppingPricePaise(item.extracted_price ?? item.price);
      if (!item.title || !item.source || pricePaise === null) { rejectedPrice++; return []; }
      const externalId = item.product_id ?? `${query}-${index}`;
      const observedAt = new Date().toISOString();
      const sourceUrl = item.product_link ?? item.link;
      const deliverySupported = Boolean(item.delivery && context.locationLabel && !/\b(?:not available|unavailable|cannot|can't|no delivery)\b/i.test(item.delivery));
      const lower = item.title.toLowerCase();
      const attributes: Record<string, unknown> = { ...extractListingCapabilities(item.title, item.snippet), extraction: "listing-title-evidence", delivery: item.delivery ?? null, locationCompatibility: deliverySupported ? "SUPPORTED_EVIDENCE" : "UNKNOWN" };
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
    }).slice(0, 10);
    marketDiagnostic("SHOPPING_CANDIDATE_COUNTS", { needId: need.id, shoppingResultsReturned: shoppingResults.length, candidatesWithParsedPrice: offers.length, candidatesRejectedPrice: rejectedPrice });
    return offers;
  }

  async revalidate(offer: MarketOffer, need: MissionNeed, context: MarketSearchContext) {
    const results = await this.search(need, context);
    return results.find((candidate) => candidate.source.externalId === offer.source.externalId) ?? null;
  }
}

type SerperShoppingResult = { title?: string; source?: string; link?: string; price?: string | number; rating?: number; ratingCount?: number; productId?: string; delivery?: string; imageUrl?: string };

export class SerperShoppingConnector implements MarketConnector {
  readonly connectorId = "serper-google-shopping";
  constructor(private readonly apiKey = process.env.SERPER_API_KEY ?? "", private readonly fetcher: typeof fetch = fetch) {}
  supports(need: MissionNeed) { return need.kind === "PRODUCT" || need.kind === "OTHER_COMMERCE"; }

  async search(need: MissionNeed, context: MarketSearchContext) {
    if (!this.apiKey) throw new ContinuityError("LIVE_MARKET_CONFIGURATION_MISSING", "SERPER_API_KEY is required when the Serper market provider is selected", 503);
    const query = marketQueryFor(need, context); const startedAt = Date.now(); let response: Response;
    try { response = await this.fetcher("https://google.serper.dev/shopping", { method: "POST", headers: { "X-API-KEY": this.apiKey, "Content-Type": "application/json" }, body: JSON.stringify({ q: query, gl: "in", hl: "en" }), signal: AbortSignal.timeout(SHOPPING_TIMEOUT_MS) }); }
    catch (error) { marketDiagnostic("SHOPPING_REQUEST_END", { provider: "serper", query, elapsedMs: Date.now() - startedAt, error: error instanceof Error ? error.name : "request_failed" }); throw error; }
    if (!response.ok) { marketDiagnostic("SHOPPING_REQUEST_END", { provider: "serper", query, httpStatus: response.status, elapsedMs: Date.now() - startedAt }); throw new ContinuityError("LIVE_MARKET_PROVIDER_FAILED", "Live shopping search failed", 502, { providerStatus: response.status }); }
    const body = await response.json() as { shopping?: SerperShoppingResult[] }; const shoppingResults = body.shopping ?? []; let rejectedPrice = 0;
    const offers = shoppingResults.flatMap((item, index): MarketOffer[] => {
      const pricePaise = parseShoppingPricePaise(item.price);
      if (!item.title || !item.source || pricePaise === null) { rejectedPrice++; return []; }
      const externalId = item.productId ?? `${query}-${index}`; const observedAt = new Date().toISOString();
      const deliverySupported = Boolean(item.delivery && context.locationLabel && !/\b(?:not available|unavailable|cannot|can't|no delivery)\b/i.test(item.delivery));
      const lower = item.title.toLowerCase(); const attributes: Record<string, unknown> = { ...extractListingCapabilities(item.title), extraction: "listing-title-evidence", delivery: item.delivery ?? null, locationCompatibility: deliverySupported ? "SUPPORTED_EVIDENCE" : "UNKNOWN" };
      for (const [key, expected] of Object.entries(need.requiredAttributes)) {
        if (key === "refreshRateHz") { const hz = lower.match(/(\d{2,3})\s*hz/); if (hz) attributes[key] = Number(hz[1]); }
        else if (typeof expected === "boolean" && expected && lower.includes(key.toLowerCase())) attributes[key] = true;
        else if (typeof expected === "string" && lower.includes(expected.toLowerCase())) attributes[key] = expected;
      }
      return [{ id: randomUUID(), needId: need.id, source: { provider: this.connectorId, externalId, url: item.link }, merchant: { name: item.source }, title: item.title, pricePaise, currency: "INR", availability: "UNKNOWN", observedAt, sourceVersion: version([externalId, pricePaise, item.source, item.title, observedAt]), attributes, evidence: { title: item.title, sourceUrl: item.link, locationLabel: context.locationLabel, deliveryText: item.delivery, locationCompatibility: deliverySupported ? "SUPPORTED_EVIDENCE" : "UNKNOWN", pricingStatus: "KNOWN", rating: item.rating }, reversibility: { type: "UNKNOWN" } }];
    }).slice(0, 10);
    marketDiagnostic("SHOPPING_REQUEST_END", { provider: "serper", query, httpStatus: response.status, resultsCount: shoppingResults.length, elapsedMs: Date.now() - startedAt });
    marketDiagnostic("SHOPPING_CANDIDATE_COUNTS", { needId: need.id, shoppingResultsReturned: shoppingResults.length, candidatesWithParsedPrice: offers.length, candidatesRejectedPrice: rejectedPrice });
    return offers;
  }

  async revalidate(offer: MarketOffer, need: MissionNeed, context: MarketSearchContext) { return (await this.search(need, context)).find((candidate) => candidate.source.externalId === offer.source.externalId) ?? null; }
}

type SerperPlaceResult = { title?: string; address?: string; latitude?: number; longitude?: number; rating?: number; ratingCount?: number; category?: string; website?: string; phoneNumber?: string; cid?: string; placeId?: string; description?: string };

export class SerperPlacesConnector implements MarketConnector {
  readonly connectorId = "serper-places";
  constructor(private readonly apiKey = process.env.SERPER_API_KEY ?? "", private readonly fetcher: typeof fetch = fetch) {}
  supports(need: MissionNeed) { return need.kind === "RESTAURANT" || need.kind === "LOCAL_SERVICE"; }
  async search(need: MissionNeed, context: MarketSearchContext) {
    if (!this.apiKey) throw new ContinuityError("LIVE_MARKET_CONFIGURATION_MISSING", "SERPER_API_KEY is required when the Serper market provider is selected", 503);
    if (!context.locationLabel) throw new ContinuityError("NO_SUPPORTED_MARKET_SOURCE", `${need.label} requires a target location for local search`, 422, { needId: need.id });
    const query = marketQueryFor(need, context); const startedAt = Date.now(); let response: Response;
    try { response = await this.fetcher("https://google.serper.dev/places", { method: "POST", headers: { "X-API-KEY": this.apiKey, "Content-Type": "application/json" }, body: JSON.stringify({ q: query, gl: "in", hl: "en", location: context.locationLabel }), signal: AbortSignal.timeout(SHOPPING_TIMEOUT_MS) }); }
    catch (error) { marketDiagnostic("LOCAL_REQUEST_END", { provider: "serper", query, elapsedMs: Date.now() - startedAt, error: error instanceof Error ? error.name : "request_failed" }); throw error; }
    if (!response.ok) throw new ContinuityError("LIVE_MARKET_PROVIDER_FAILED", "Live local search failed", 502, { providerStatus: response.status });
    const body = await response.json() as { places?: SerperPlaceResult[] }; const places = body.places ?? [];
    const offers = places.flatMap((item, index): MarketOffer[] => {
      if (!item.title) return []; const externalId = item.placeId ?? item.cid ?? `${query}-${index}`; const observedAt = new Date().toISOString();
      return [{ id: randomUUID(), needId: need.id, source: { provider: this.connectorId, externalId, url: item.website }, merchant: { name: item.title, location: item.address }, title: item.title, description: item.description, pricePaise: null, currency: "INR", availability: "UNKNOWN", observedAt, sourceVersion: version([externalId, item.title, item.address, item.rating, item.ratingCount, observedAt]), attributes: { type: item.category ?? null, rating: item.rating ?? null, reviewCount: item.ratingCount ?? null, address: item.address ?? null, latitude: item.latitude ?? null, longitude: item.longitude ?? null }, evidence: { title: item.title, snippet: item.description, sourceUrl: item.website, locationLabel: context.locationLabel, locationCompatibility: "SUPPORTED_EVIDENCE", rating: item.rating, reviewCount: item.ratingCount, address: item.address, pricingStatus: "UNKNOWN" }, reversibility: { type: "UNKNOWN" } }];
    }).slice(0, 10);
    marketDiagnostic("LOCAL_REQUEST_END", { provider: "serper", query, httpStatus: response.status, resultsCount: offers.length, elapsedMs: Date.now() - startedAt });
    return offers;
  }
  async revalidate(offer: MarketOffer, need: MissionNeed, context: MarketSearchContext) { return (await this.search(need, context)).find((candidate) => candidate.source.externalId === offer.source.externalId) ?? null; }
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
    const startedAt = Date.now();
    let response: Response;
    try { response = await this.fetcher(url, { signal: AbortSignal.timeout(SHOPPING_TIMEOUT_MS) }); }
    catch (error) { marketDiagnostic("SHOPPING_REQUEST_END", { provider: this.connectorId, elapsedMs: Date.now() - startedAt, error: error instanceof Error ? error.name : "request_failed" }); throw error; }
    marketDiagnostic("SHOPPING_REQUEST_END", { provider: this.connectorId, httpStatus: response.status, elapsedMs: Date.now() - startedAt });
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
    const provider = process.env.MISSIONPAY_MARKET_PROVIDER ?? "serpapi";
    this.connectors = connectors ?? (mode === "live" ? provider === "serper" ? [new SerperShoppingConnector(), new SerperPlacesConnector()] : [new SerpApiShoppingConnector(), new SerpApiLocalPlacesConnector()] : [new SandboxShoppingConnector()]);
  }

  private connectorFor(need: MissionNeed) { return this.connectors.find((connector) => connector.supports(need)); }

  async search(needs: MissionNeed[], context: MarketSearchContext): Promise<MarketSearchResult[]> {
    const results = await boundedMap(needs, 2, async (need): Promise<MarketSearchResult> => {
      const query = marketQueryFor(need, context);
      const connector = this.connectorFor(need);
      if (!connector) return { need, connectorId: null, query, offers: [], error: new ContinuityError("NO_SUPPORTED_MARKET_SOURCE", `No supported market source exists for ${need.label}`, 422, { needId: need.id, kind: need.kind }) };
      try {
        let offers = await connector.search(need, context);
        if (!offers.some(hasKnownPrice) && need.kind === "PRODUCT") offers = await connector.search(refinedShoppingNeed(need), context);
        if (!offers.length) return { need, connectorId: connector.connectorId, query, offers, error: new ContinuityError("NO_SUPPORTED_MARKET_SOURCE", `No supported market results found for ${need.label}`, 409, { needId: need.id }) };
        if (!offers.some(hasKnownPrice)) return { need, connectorId: connector.connectorId, query, offers, error: new ContinuityError("INSUFFICIENT_PRICING_EVIDENCE", `No exact transaction price is available for ${need.label}`, 409, { needId: need.id }) };
        return { need, connectorId: connector.connectorId, query, offers };
      } catch (error) {
        return { need, connectorId: connector.connectorId, query, offers: [], error: error instanceof ContinuityError ? error : new ContinuityError("MARKET_SEARCH_FAILED", "Market search failed", 502) };
      }
    });
    if (results.every((result) => result.offers.length === 0)) throw results.find((result) => result.error)?.error;
    return results;
  }

  async revalidate(offer: MarketOffer, need: MissionNeed, context: MarketSearchContext) {
    const connector = this.connectors.find((candidate) => candidate.connectorId === offer.source.provider) ?? this.connectorFor(need);
    return connector?.revalidate?.(offer, need, context) ?? null;
  }
}
