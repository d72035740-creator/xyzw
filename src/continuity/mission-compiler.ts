import { createHash } from "node:crypto";
import { missionSpecSchema, type MissionLocation, type MissionLocationInput, type MissionSpec, ContinuityError } from "./types";
import { validateMissionNeeds } from "./mission-semantic-validator";

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
  if (radius?.[1]) return { source: "prompt", label: radius[1].trim() };
  const situated = goal.match(new RegExp(String.raw`\bin\s+([a-z][a-z0-9 .'-]{1,80}?)${boundary}`, "i"));
  return situated?.[1] && !/^(?:the|a|an|\d+\s+(?:minutes?|hours?|days?))$/i.test(situated[1].trim())
    ? { source: "prompt", label: situated[1].trim() }
    : undefined;
}

export function resolveMissionLocation(goal: string, input?: MissionLocationInput | string): MissionLocation | undefined {
  const prompt = promptTargetLocation(goal);
  if (prompt) return prompt;
  if (typeof input === "string") return input.trim() ? { source: "manual", label: input.trim() } : undefined;
  if (input?.manualLabel?.trim()) return { source: "manual", label: input.manualLabel.trim() };
  return input?.browser;
}

function participantsFrom(goal: string) {
  const participants: Array<{ label: string; count?: number; role?: string }> = [];
  const add = (label: string, count: number | undefined, role: string) => {
    if (!participants.some((participant) => participant.label === label && participant.role === role)) participants.push({ label, count, role });
  };
  if (/\b(?:with|date with)\s+(?:my\s+)?(?:girlfriend|boyfriend|partner|wife|husband|spouse)\b/i.test(goal)) add("partner", 2, "participant");
  else if (/\bfor\s+(?:my\s+)?(?:girlfriend|boyfriend|partner|wife|husband|spouse)\b/i.test(goal)) add("partner", 1, "beneficiary");
  if (/\b(?:my\s+)?parents\b/i.test(goal)) add("parents", 2, "beneficiary");
  if (/\b(?:my\s+)?friend(?:'s)?\b/i.test(goal)) add("friend", 1, "participant");
  if (/\b(?:my\s+)?team\b/i.test(goal)) add("team", undefined, "participant");
  if (/\b(?:my\s+)?professor\b/i.test(goal)) add("professor", 1, "beneficiary");
  const group = goal.match(/\b(?:for\s+)?(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:people|persons?|guests?)\b/i);
  if (group) {
    const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    add("guests", words[group[1].toLowerCase()] ?? Number(group[1]), "participant");
  }
  return participants;
}

function need(label: string, kind: "PRODUCT" | "LOCAL_SERVICE" | "RESTAURANT" | "TRAVEL" | "OTHER_COMMERCE", index: number) {
  const lower = label.toLowerCase();
  const requiredAttributes: Record<string, string | number | boolean> = {};
  const hz = lower.match(/(\d{2,3})\s*hz/); if (hz) requiredAttributes.refreshRateHz = Number(hz[1]);
  if (/mechanical/.test(lower)) requiredAttributes.mechanical = true;
  if (/wireless/.test(lower)) requiredAttributes.wireless = true;
  if (/ergonomic/.test(lower)) requiredAttributes.ergonomic = true;
  const noun = lower.replace(/\b\d{2,3}\s*hz\b|\b(mechanical|wireless|ergonomic|gaming)\b/g, "").trim() || label;
  return { id: `${slug(noun)}-${index + 1}`, label, kind, quantity: 1, searchQueries: [`${label} India`], requiredAttributes, dependencies: [] as string[] };
}

function heuristicNeeds(goal: string) {
  const recognized: Array<{ pattern: RegExp; label: string; kind: "PRODUCT" | "RESTAURANT" }> = [
    { pattern: /\b(?:restaurant|dinner|dining|meal)\b/i, label: "Restaurant dinner", kind: "RESTAURANT" },
    { pattern: /\b(?:flowers?|bouquet)\b/i, label: "Flowers", kind: "PRODUCT" },
    { pattern: /\b(?:birthday\s+)?cake\b/i, label: "Birthday cake", kind: "PRODUCT" },
    { pattern: /\b(?:television|tv)\b/i, label: "Television", kind: "PRODUCT" },
    { pattern: /\b(?:\d{2,3}\s*hz\s+)?monitor\b/i, label: goal.match(/\b(?:\d{2,3}\s*hz\s+)?monitor\b/i)?.[0] ?? "Monitor", kind: "PRODUCT" },
    { pattern: /\b(?:mechanical\s+)?keyboard\b/i, label: goal.match(/\b(?:mechanical\s+)?keyboard\b/i)?.[0] ?? "Keyboard", kind: "PRODUCT" },
    { pattern: /\b(?:wireless\s+)?mouse\b/i, label: goal.match(/\b(?:wireless\s+)?mouse\b/i)?.[0] ?? "Mouse", kind: "PRODUCT" },
    { pattern: /\b(?:ergonomic\s+)?chair\b/i, label: goal.match(/\b(?:ergonomic\s+)?chair\b/i)?.[0] ?? "Chair", kind: "PRODUCT" },
  ];
  const seen = new Set<string>();
  const needs = recognized.filter((candidate) => candidate.pattern.test(goal)).filter((candidate) => {
    const key = candidate.label.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map((candidate, index) => need(candidate.label, candidate.kind, index));
  if (needs.length) return needs;

  const object = goal.match(/\b(?:buy|purchase|order|book|reserve|hire|get)\s+(?:(?:my|the)\s+(?:parents?|partner|friend|team|professor)\s+)?(?:a|an|the)?\s*([^,.]+?)(?=\s+(?:for|under|below|within|in|at|by|before)\b|[,.]|$)/i)?.[1]?.trim();
  if (!object) throw new ContinuityError("INVALID_MISSION_NEED", "MissionPay could not identify something purchasable or bookable in this mission.", 422);
  return [need(object, /\b(?:restaurant|dinner|cafe|meal)\b/i.test(object) ? "RESTAURANT" : "OTHER_COMMERCE", 0)];
}

function normalizedGoal(goal: string) {
  if (/\b(?:restaurant|dinner|dining|meal)\b/i.test(goal) && /\b(?:girlfriend|boyfriend|partner|wife|husband|spouse)\b/i.test(goal)) return "Dinner with your partner";
  return goal.trim();
}

function compileHeuristically(goal: string, budgetPaise: number, location: MissionLocation | undefined, repairAllowancePaise: number) {
  const needs = heuristicNeeds(goal);
  const participants = participantsFrom(goal);
  const constraints = [{ id: "budget", description: `Total authority must not exceed ${budgetPaise} paise` }];
  const partySize = participants.find((participant) => participant.role === "participant")?.count;
  if (partySize) constraints.push({ id: "party-size", description: `Table/service for ${partySize} people` });
  return validateMissionNeeds(missionSpecSchema.parse({
    goal: normalizedGoal(goal), budgetPaise, currency: "INR", location, participants, needs,
    globalConstraints: constraints,
    outcome: { requiredNeedIds: needs.map((item) => item.id), predicates: needs.flatMap((item) => Object.entries(item.requiredAttributes).map(([key, expected]) => ({ id: `${item.id}-${key}`, description: `${item.label}: ${key} ${expected}`, type: "ATTRIBUTE", needId: item.id, key, operator: ">=", expected }))) },
    repairAuthority: { allowAutomaticSubstitution: true, maxAdditionalSpendPaise: repairAllowancePaise },
  }), goal);
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
    return compileHeuristically(input.goal, budgetPaise, location, input.repairAllowancePaise ?? 0);
  }

  private async compileWithOpenAI(input: { goal: string; maximumAuthorityPaise: number; location?: MissionLocation; repairAllowancePaise?: number }) {
    const apiKey = process.env.OPENAI_API_KEY; const model = process.env.OPENAI_PLANNER_MODEL;
    if (!apiKey || !model) throw new ContinuityError("PLANNER_CONFIGURATION_MISSING", "OPENAI_API_KEY and OPENAI_PLANNER_MODEL are required", 503);
    const schema = { type: "object", additionalProperties: false, required: ["goal","budgetPaise","currency","participants","needs","globalConstraints","outcome","repairAuthority"], properties: { goal:{type:"string"}, budgetPaise:{type:"integer"}, currency:{type:"string",enum:["INR"]}, participants:{type:"array",items:{type:"object",additionalProperties:false,required:["label","count","role"],properties:{label:{type:"string"},count:{type:["integer","null"]},role:{type:["string","null"]}}}}, needs:{type:"array",items:{type:"object",additionalProperties:false,required:["id","label","kind","quantity","searchQueries","requiredAttributes","dependencies"],properties:{id:{type:"string"},label:{type:"string"},kind:{type:"string",enum:["PRODUCT","LOCAL_SERVICE","RESTAURANT","TRAVEL","OTHER_COMMERCE"]},quantity:{type:"integer"},searchQueries:{type:"array",items:{type:"string"}},requiredAttributes:{type:"array",items:{type:"object",additionalProperties:false,required:["key","value"],properties:{key:{type:"string"},value:{type:["string","number","boolean"]}}}},dependencies:{type:"array",items:{type:"string"}}}}}, globalConstraints:{type:"array",items:{type:"object",additionalProperties:false,required:["id","description"],properties:{id:{type:"string"},description:{type:"string"}}}}, outcome:{type:"object",additionalProperties:false,required:["requiredNeedIds","predicates"],properties:{requiredNeedIds:{type:"array",items:{type:"string"}},predicates:{type:"array",items:{type:"object",additionalProperties:false,required:["id","description","type","needId","key","operator","expected"],properties:{id:{type:"string"},description:{type:"string"},type:{type:"string"},needId:{type:["string","null"]},key:{type:["string","null"]},operator:{type:["string","null"]},expected:{type:["string","number","boolean","null"]}}}}}},repairAuthority:{type:"object",additionalProperties:false,required:["allowAutomaticSubstitution","maxAdditionalSpendPaise"],properties:{allowAutomaticSubstitution:{type:"boolean"},maxAdditionalSpendPaise:{type:"integer"}}}} } as const;
    const compilerInput = { ...input, location: input.location ? { source: input.location.source, label: input.location.label } : undefined };
    const response = await fetch("https://api.openai.com/v1/responses", { method:"POST", headers:{Authorization:`Bearer ${apiKey}`,"Content-Type":"application/json"}, body:JSON.stringify({model,store:false,instructions:"Compile a commerce outcome into typed purchasable or bookable needs. Classify people and relationships only as participants, never as needs. Event names, locations, dates, budgets, adjectives, and context-only phrases are never needs. Do not infer flowers, gifts, cake, jewellery, or any other purchase the user did not explicitly request. Use PRODUCT for goods, RESTAURANT for dining, LOCAL_SERVICE for local bookable services, TRAVEL for explicitly requested travel, and OTHER_COMMERCE only for another explicit transaction. Keep search queries semantically identical to each need. Consider the supplied resolved target location but never change it. Never change the supplied budget or repair allowance. Do not invent market facts.",input:JSON.stringify(compilerInput),text:{format:{type:"json_schema",name:"mission_spec",strict:true,schema}}}) });
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
    if (Array.isArray(raw.participants)) raw.participants = raw.participants.map((participant) => Object.fromEntries(Object.entries(participant as Record<string, unknown>).filter(([, value]) => value !== null)));
    const parsed = validateMissionNeeds(missionSpecSchema.parse({ ...raw, location: input.location }), input.goal);
    if (parsed.budgetPaise !== input.maximumAuthorityPaise || parsed.repairAuthority.maxAdditionalSpendPaise !== (input.repairAllowancePaise ?? 0)) throw new ContinuityError("AI_AUTHORITY_VIOLATION", "Compiler attempted to change human authority", 409);
    return parsed;
  }
}
