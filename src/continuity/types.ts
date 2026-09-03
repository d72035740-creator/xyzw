import { z } from "zod";

export const missionNeedSchema = z.object({
  id: z.string().min(1), label: z.string().min(1), quantity: z.number().int().positive(),
  searchQueries: z.array(z.string().min(1)).min(1),
  requiredAttributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  preferredAttributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  maxPricePaise: z.number().int().positive().optional(), dependencies: z.array(z.string()),
});
export const missionSpecSchema = z.object({
  goal: z.string().min(1), budgetPaise: z.number().int().positive(), currency: z.literal("INR"),
  location: z.object({ text: z.string().min(1) }).optional(), deadline: z.string().datetime().optional(),
  needs: z.array(missionNeedSchema).min(1), globalConstraints: z.array(z.object({ id: z.string(), description: z.string() })),
  outcome: z.object({ requiredNeedIds: z.array(z.string()), predicates: z.array(z.object({ id: z.string(), description: z.string(), type: z.string(), needId: z.string().optional(), key: z.string().optional(), operator: z.string().optional(), expected: z.unknown().optional() })) }),
  repairAuthority: z.object({ allowAutomaticSubstitution: z.boolean(), maxAdditionalSpendPaise: z.number().int().nonnegative() }),
});
export type MissionSpec = z.infer<typeof missionSpecSchema>;
export type MissionNeed = z.infer<typeof missionNeedSchema>;

export type MarketOffer = {
  id: string; needId: string; source: { provider: string; externalId?: string; url?: string };
  merchant: { id?: string; name: string; location?: string }; title: string; description?: string;
  pricePaise: number; currency: "INR"; availability: "AVAILABLE" | "LIMITED" | "UNKNOWN";
  observedAt: string; sourceVersion: string; attributes: Record<string, unknown>;
  evidence?: { title?: string; snippet?: string; sourceUrl?: string };
  reversibility?: { type: "REVERSIBLE" | "PARTIAL" | "IRREVERSIBLE" | "UNKNOWN"; score?: number; evidence?: string; sourceUrl?: string };
};

export class ContinuityError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400, public readonly details?: Record<string, unknown>) { super(message); }
}
export function continuityErrorResponse(error: unknown) {
  if (error instanceof ContinuityError) return Response.json({ error: { code: error.code, message: error.message, details: error.details } }, { status: error.status });
  return Response.json({ error: { code: "CONTINUITY_ERROR", message: "Mission continuity operation failed" } }, { status: 500 });
}
