import { createHash } from "node:crypto";
import { missionSpecSchema, type MissionLocation, type MissionLocationInput, type MissionSpec, ContinuityError } from "./types";

function statedBudgetPaise(goal: string): number | null {
  const match = goal.match(/(?:under|below|within|max(?:imum)?|budget(?: of)?)\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (!match) return null;
  const rupees = Number(match[1].replaceAll(",", ""));
  return Number.isFinite(rupees) ? Math.round(rupees * 100) : null;
}

function slug(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 48) || createHash("sha1").update(value).digest("hex").slice(0, 8); }

function promptTargetLocation(goal: string): MissionLocation | undefined {
  const boundary = String.raw`(?=\s+(?:under|within|by|before|with|this|next)\b|[,.]|$)`;
  const delivery = goal.match(new RegExp(String.raw`\b(?:delivery|deliver(?:ed)?|shipping|ship)\s+(?:to|in|at)\s+([a-z][a-z0-9 .'-]{1,80}?)${boundary}`, "i"));
  if (delivery?.[1]) return { source: "prompt", label: delivery[1].trim() };
  const radius = goal.match(new RegExp(String.raw`\bwithin\s+\d+(?:\.\d+)?\s*(?:km|kilomet(?:er|re)s?)\s+of\s+([a-z][a-z0-9 .'-]{1,80}?)${boundary}`, "i"));
  return radius?.[1] ? { source: "prompt", label: radius[1].trim() } : undefined;
}

export function resolveMissionLocation(goal: string, input?: MissionLocationInput | string): MissionLocation | undefined {
  const prompt = promptTargetLocation(goal);
  if (prompt) return prompt;
  if (typeof input === "string") return input.trim() ? { source: "manual", label: input.trim() } : undefined;
  if (input?.manualLabel?.trim()) return { source: "manual", label: input.manualLabel.trim() };
  return input?.browser;
}

function heuristicNeeds(goal: string) {
  const tail = goal.split(/\bwith\b/i)[1] ?? goal.replace(/\b(?:build|buy|get|set up|create|arrange|under|below)\b/gi, " ");
  const pieces = tail.split(/,|\band\b/i).map((x) => x.replace(/under\s*(?:₹|rs\.?|inr)?\s*[\d,]+.*/i, "").trim()).filter((x) => x.length > 2).slice(0, 8);
  return (pieces.length ? pieces : ["required item"]).map((label, index) => {
    const lower = label.toLowerCase();
    const requiredAttributes: Record<string, string | number | boolean> = {};
    const hz = lower.match(/(\d{2,3})\s*hz/); if (hz) requiredAttributes.refreshRateHz = Number(hz[1]);
    if (/mechanical/.test(lower)) requiredAttributes.mechanical = true;
    if (/wireless/.test(lower)) requiredAttributes.wireless = true;
    if (/ergonomic/.test(lower)) requiredAttributes.ergonomic = true;
    const noun = lower.replace(/\b\d{2,3}\s*hz\b|\b(mechanical|wireless|ergonomic|gaming)\b/g, "").trim() || label;
    return { id: `${slug(noun)}-${index + 1}`, label: label.trim(), quantity: 1, searchQueries: [`${label.trim()} India`], requiredAttributes, dependencies: [] as string[] };
  });
}

function extractOutputText(payload: Record<string, unknown>) {
  if (typeof payload.output_text === "string") return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = Array.isArray((item as { content?: unknown }).content) ? (item as { content: unknown[] }).content : [];
    for (const part of content) {
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") return (part as { text: string }).text;
    }
  }
  return null;
}

export class MissionCompiler {
  async compile(input: { goal: string; maximumAuthorityPaise?: number; location?: MissionLocationInput | string; repairAllowancePaise?: number }): Promise<MissionSpec> {
    const described = statedBudgetPaise(input.goal);
    if (described && input.maximumAuthorityPaise && described !== input.maximumAuthorityPaise) throw new ContinuityError("BUDGET_CONSTRAINT_MISMATCH", `Your mission says ₹${(described / 100).toLocaleString("en-IN")} but your maximum authority is ₹${(input.maximumAuthorityPaise / 100).toLocaleString("en-IN")}. Make them match before authorizing.`, 409, { describedBudgetPaise: described, maximumAuthorityPaise: input.maximumAuthorityPaise });
    const budgetPaise = input.maximumAuthorityPaise ?? described;
    if (!budgetPaise) throw new ContinuityError("BUDGET_REQUIRED", "Add a maximum authority or include a budget in the mission.");
    const location = resolveMissionLocation(input.goal, input.location);
    if (process.env.MISSIONPAY_PLANNER_PROVIDER === "openai") return this.compileWithOpenAI({ ...input, location, maximumAuthorityPaise: budgetPaise });
    const needs = heuristicNeeds(input.goal);
    return missionSpecSchema.parse({ goal: input.goal, budgetPaise, currency: "INR", location, needs, globalConstraints: [{ id: "budget", description: `Total authority must not exceed ${budgetPaise} paise` }], outcome: { requiredNeedIds: needs.map((n) => n.id), predicates: needs.flatMap((n) => Object.entries(n.requiredAttributes).map(([key, expected]) => ({ id: `${n.id}-${key}`, description: `${n.label}: ${key} ${expected}`, type: "ATTRIBUTE", needId: n.id, key, operator: ">=", expected }))) }, repairAuthority: { allowAutomaticSubstitution: true, maxAdditionalSpendPaise: input.repairAllowancePaise ?? 0 } });
  }

  private async compileWithOpenAI(input: { goal: string; maximumAuthorityPaise: number; location?: MissionLocation; repairAllowancePaise?: number }) {
    const apiKey = process.env.OPENAI_API_KEY; const model = process.env.OPENAI_PLANNER_MODEL;
    if (!apiKey || !model) throw new ContinuityError("PLANNER_CONFIGURATION_MISSING", "OPENAI_API_KEY and OPENAI_PLANNER_MODEL are required", 503);
    const schema = { type: "object", additionalProperties: false, required: ["goal","budgetPaise","currency","needs","globalConstraints","outcome","repairAuthority"], properties: { goal:{type:"string"}, budgetPaise:{type:"integer"}, currency:{type:"string",enum:["INR"]}, needs:{type:"array",items:{type:"object",additionalProperties:false,required:["id","label","quantity","searchQueries","requiredAttributes","dependencies"],properties:{id:{type:"string"},label:{type:"string"},quantity:{type:"integer"},searchQueries:{type:"array",items:{type:"string"}},requiredAttributes:{type:"array",items:{type:"object",additionalProperties:false,required:["key","value"],properties:{key:{type:"string"},value:{type:["string","number","boolean"]}}}},dependencies:{type:"array",items:{type:"string"}}}}}, globalConstraints:{type:"array",items:{type:"object",additionalProperties:false,required:["id","description"],properties:{id:{type:"string"},description:{type:"string"}}}}, outcome:{type:"object",additionalProperties:false,required:["requiredNeedIds","predicates"],properties:{requiredNeedIds:{type:"array",items:{type:"string"}},predicates:{type:"array",items:{type:"object",additionalProperties:false,required:["id","description","type","needId","key","operator","expected"],properties:{id:{type:"string"},description:{type:"string"},type:{type:"string"},needId:{type:["string","null"]},key:{type:["string","null"]},operator:{type:["string","null"]},expected:{type:["string","number","boolean","null"]}}}}}},repairAuthority:{type:"object",additionalProperties:false,required:["allowAutomaticSubstitution","maxAdditionalSpendPaise"],properties:{allowAutomaticSubstitution:{type:"boolean"},maxAdditionalSpendPaise:{type:"integer"}}}} } as const;
    const compilerInput = { ...input, location: input.location ? { source: input.location.source, label: input.location.label } : undefined };
    const response = await fetch("https://api.openai.com/v1/responses", { method:"POST", headers:{Authorization:`Bearer ${apiKey}`,"Content-Type":"application/json"}, body:JSON.stringify({model,store:false,instructions:"Compile a commerce outcome into dynamic needs. Consider the supplied resolved target location for delivery, local-service, deadline, and availability intent. Never change or infer a different target location. Never change the supplied budget or repair allowance. Do not invent market facts.",input:JSON.stringify(compilerInput),text:{format:{type:"json_schema",name:"mission_spec",strict:true,schema}}}) });
    if (!response.ok) throw new ContinuityError("PLANNER_PROVIDER_FAILED", "Mission compiler request failed", 502, { providerStatus: response.status });
    const text = extractOutputText(await response.json() as Record<string, unknown>); if (!text) throw new ContinuityError("INVALID_AI_RESPONSE", "Mission compiler returned no structured output", 502);
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (Array.isArray(raw.needs)) raw.needs = raw.needs.map((need) => {
      const item = need as Record<string, unknown>;
      const attributes = Array.isArray(item.requiredAttributes)
        ? Object.fromEntries(item.requiredAttributes.map((entry) => [(entry as { key: string }).key, (entry as { value: unknown }).value]))
        : item.requiredAttributes;
      return { ...item, requiredAttributes: attributes };
    });
    if (raw.outcome && typeof raw.outcome === "object") {
      const outcome = raw.outcome as { predicates?: Array<Record<string, unknown>> };
      if (Array.isArray(outcome.predicates)) outcome.predicates = outcome.predicates.map((predicate) => Object.fromEntries(Object.entries(predicate).filter(([, value]) => value !== null)));
    }
    const parsed = missionSpecSchema.parse({ ...raw, location: input.location });
    if (parsed.budgetPaise !== input.maximumAuthorityPaise || parsed.repairAuthority.maxAdditionalSpendPaise !== (input.repairAllowancePaise ?? 0)) throw new ContinuityError("AI_AUTHORITY_VIOLATION", "Compiler attempted to change human authority", 409);
    return parsed;
  }
}
