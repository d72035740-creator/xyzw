import { createHash, randomUUID } from "node:crypto";
import type { MarketOffer, MissionNeed } from "./types";
import { ContinuityError } from "./types";

export type MarketSearchContext = { missionId: string; location?: string };
export interface MarketConnector { readonly connectorId: string; supports(need: MissionNeed): boolean; search(need: MissionNeed, context: MarketSearchContext): Promise<MarketOffer[]>; revalidate?(offer: MarketOffer, need: MissionNeed, context: MarketSearchContext): Promise<MarketOffer | null>; }
const version = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

type SerpShoppingResult = { product_id?: string; title?: string; source?: string; extracted_price?: number; price?: string; product_link?: string; link?: string; snippet?: string; delivery?: string };
export class SerpApiShoppingConnector implements MarketConnector {
  readonly connectorId = "serpapi-google-shopping";
  constructor(private readonly apiKey = process.env.SERPAPI_API_KEY ?? "", private readonly fetcher: typeof fetch = fetch) {}
  supports() { return true; }
  async search(need: MissionNeed, context: MarketSearchContext) {
    if (!this.apiKey) throw new ContinuityError("LIVE_MARKET_CONFIGURATION_MISSING", "SERPAPI_API_KEY is required in live market mode", 503);
    const query = need.searchQueries[0]; const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google_shopping"); url.searchParams.set("q", query); url.searchParams.set("gl", "in"); url.searchParams.set("hl", "en"); url.searchParams.set("api_key", this.apiKey); if (context.location) url.searchParams.set("location", context.location);
    const response = await this.fetcher(url, { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new ContinuityError("LIVE_MARKET_PROVIDER_FAILED", "Live shopping search failed", 502, { providerStatus: response.status });
    const body = await response.json() as { shopping_results?: SerpShoppingResult[] };
    return (body.shopping_results ?? []).flatMap((item, index): MarketOffer[] => {
      if (!item.title || !item.source || !Number.isFinite(item.extracted_price) || item.extracted_price! <= 0) return [];
      const pricePaise = Math.round(item.extracted_price! * 100); const externalId = item.product_id ?? `${query}-${index}`; const observedAt = new Date().toISOString(); const sourceUrl = item.product_link ?? item.link;
      const lower=item.title.toLowerCase(); const attributes:Record<string,unknown>={extraction:"listing-title-evidence",delivery:item.delivery??null};
      for(const [key,expected] of Object.entries(need.requiredAttributes)){ if(key==="refreshRateHz"){const hz=lower.match(/(\d{2,3})\s*hz/); if(hz) attributes[key]=Number(hz[1]);} else if(typeof expected==="boolean"&&expected&&lower.includes(key.toLowerCase())) attributes[key]=true; else if(typeof expected==="string"&&lower.includes(expected.toLowerCase())) attributes[key]=expected; }
      return [{ id: randomUUID(), needId: need.id, source:{provider:this.connectorId,externalId,url:sourceUrl}, merchant:{name:item.source}, title:item.title, description:item.snippet, pricePaise,currency:"INR",availability:"UNKNOWN",observedAt,sourceVersion:version([externalId,pricePaise,item.source,item.title,observedAt]),attributes,evidence:{title:item.title,snippet:item.snippet,sourceUrl},reversibility:{type:"UNKNOWN"} }];
    }).slice(0, 8);
  }
  async revalidate(offer: MarketOffer, need: MissionNeed, context: MarketSearchContext) { const results = await this.search(need, context); return results.find((candidate) => candidate.source.externalId === offer.source.externalId) ?? null; }
}

export class SandboxShoppingConnector implements MarketConnector {
  readonly connectorId = "missionpay-sandbox"; supports() { return true; }
  async search(need: MissionNeed) { const seed = [...need.id].reduce((n,c)=>n+c.charCodeAt(0),0); const base = 250000 + (seed % 9000) * 10; return [0,1,2].map((index):MarketOffer=>({id:randomUUID(),needId:need.id,source:{provider:this.connectorId,externalId:`${need.id}-${index+1}`},merchant:{name:`Sandbox Merchant ${index+1}`},title:`${need.label} — Sandbox option ${index+1}`,pricePaise:base+index*45000,currency:"INR",availability:"AVAILABLE",observedAt:new Date().toISOString(),sourceVersion:version([need.id,index,base]),attributes:{...need.requiredAttributes,synthetic:true},evidence:{title:"Synthetic sandbox listing"},reversibility:{type:"UNKNOWN"}})); }
  async revalidate(offer: MarketOffer) { return {...offer, observedAt:new Date().toISOString()}; }
}

export class MarketGateway {
  readonly mode: "live"|"sandbox"; private readonly connector: MarketConnector;
  constructor(mode=(process.env.MISSIONPAY_MARKET_MODE ?? "sandbox") as "live"|"sandbox") { this.mode=mode; this.connector=mode==="live"?new SerpApiShoppingConnector():new SandboxShoppingConnector(); }
  async search(needs: MissionNeed[], context: MarketSearchContext) { const settled=await Promise.allSettled(needs.map(async need=>({need,offers:await this.connector.search(need,context)}))); const results=settled.map((result,index)=>result.status==="fulfilled"?result.value:{need:needs[index],offers:[] as MarketOffer[],error:result.reason instanceof ContinuityError?result.reason:new ContinuityError("MARKET_SEARCH_FAILED","Market search failed",502)}); if(results.every(r=>r.offers.length===0)){const first=results.find(r=>"error" in r); if(first&&"error" in first) throw first.error;} return results; }
  async revalidate(offer: MarketOffer, need: MissionNeed, context: MarketSearchContext) { return this.connector.revalidate?.(offer,need,context) ?? null; }
}
