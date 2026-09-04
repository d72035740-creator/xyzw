import { z } from "zod";

export const missionNeedKindSchema = z.enum(["PRODUCT", "LOCAL_SERVICE", "RESTAURANT", "TRAVEL", "OTHER_COMMERCE"]);
export const missionNeedSchema = z.object({
  id: z.string().min(1), label: z.string().min(1), quantity: z.number().int().positive(),
  kind: missionNeedKindSchema.default("OTHER_COMMERCE"),
  searchQueries: z.array(z.string().min(1)).min(1),
  requiredAttributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  preferredAttributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  maxPricePaise: z.number().int().positive().optional(), dependencies: z.array(z.string()),
});
export const missionLocationSchema = z.object({
  source: z.enum(["browser", "manual", "prompt"]),
  label: z.string().min(1).max(200),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  accuracyMeters: z.number().nonnegative().max(100_000).optional(),
});
export const missionLocationInputSchema = z.object({
  browser: missionLocationSchema.extend({ source: z.literal("browser") }).optional(),
  manualLabel: z.string().trim().min(1).max(200).optional(),
}).strict();
const persistedMissionLocationSchema = z.preprocess((value) => {
  if (value && typeof value === "object" && "text" in value && typeof (value as { text?: unknown }).text === "string") return { source: "manual", label: (value as { text: string }).text };
  return value;
}, missionLocationSchema.optional());
export const missionSpecSchema = z.object({
  goal: z.string().min(1), budgetPaise: z.number().int().positive(), currency: z.literal("INR"),
  location: persistedMissionLocationSchema, deadline: z.string().datetime().optional(),
  participants: z.array(z.object({ label: z.string().min(1), count: z.number().int().positive().optional(), role: z.string().min(1).optional() })).default([]),
  needs: z.array(missionNeedSchema).min(1), globalConstraints: z.array(z.object({ id: z.string(), description: z.string() })),
  outcome: z.object({ requiredNeedIds: z.array(z.string()), predicates: z.array(z.object({ id: z.string(), description: z.string(), type: z.string(), needId: z.string().optional(), key: z.string().optional(), operator: z.string().optional(), expected: z.unknown().optional() })) }),
  repairAuthority: z.object({ allowAutomaticSubstitution: z.boolean(), maxAdditionalSpendPaise: z.number().int().nonnegative() }),
});
export type MissionSpec = z.infer<typeof missionSpecSchema>;
export type MissionNeed = z.infer<typeof missionNeedSchema>;
export type MissionNeedKind = z.infer<typeof missionNeedKindSchema>;
export type MissionLocation = z.infer<typeof missionLocationSchema>;
export type MissionLocationInput = z.infer<typeof missionLocationInputSchema>;

export type MarketOffer = {
  id: string; needId: string; source: { provider: string; externalId?: string; url?: string };
  merchant: { id?: string; name: string; location?: string }; title: string; description?: string;
  pricePaise: number | null; currency: "INR"; availability: "AVAILABLE" | "LIMITED" | "UNKNOWN";
  observedAt: string; sourceVersion: string; attributes: Record<string, unknown>;
  evidence?: { title?: string; snippet?: string; sourceUrl?: string; locationLabel?: string; deliveryText?: string; locationCompatibility?: "SUPPORTED_EVIDENCE" | "UNKNOWN"; rating?: number; reviewCount?: number; address?: string; priceText?: string; pricingStatus?: "KNOWN" | "UNKNOWN" };
  reversibility?: { type: "REVERSIBLE" | "PARTIAL" | "IRREVERSIBLE" | "UNKNOWN"; score?: number; evidence?: string; sourceUrl?: string };
};

export class ContinuityError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400, public readonly details?: Record<string, unknown>) { super(message); }
}
export function continuityErrorResponse(error: unknown) {
  if (error instanceof ContinuityError) return Response.json({ error: { code: error.code, message: error.message, details: error.details } }, { status: error.status });
  return Response.json({ error: { code: "CONTINUITY_ERROR", message: "Mission continuity operation failed" } }, { status: 500 });
}

export function withoutPreciseLocation<T extends { spec: { location?: MissionLocation } }>(view: T | null): T | null {
  if (!view?.spec.location) return view;
  return { ...view, spec: { ...view.spec, location: { source: view.spec.location.source, label: view.spec.location.label } } } as T;
}
