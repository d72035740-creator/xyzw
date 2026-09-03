import { z } from "zod";

const integerPaise = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const createMissionSchema = z.object({
  goal: z.string().trim().min(1).max(2_000),
  budgetAmount: integerPaise,
  deadline: z.coerce.date(),
  constraints: z
    .object({
      people: z.number().int().positive().max(100).optional(),
      vegetarian: z.boolean().optional(),
    })
    .strict()
    .default({}),
  requiredCategories: z
    .array(z.enum(["CAKE", "FLOWERS", "RESTAURANT"]))
    .min(1)
    .refine((categories) => new Set(categories).size === categories.length, {
      message: "Required categories must be unique",
    })
    .default(["CAKE", "FLOWERS", "RESTAURANT"]),
});

export const reserveOfferSchema = z.object({
  offerId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  expectedOfferVersion: z.number().int().positive().optional(),
});

export const versionMutationSchema = z.object({
  expectedVersion: z.number().int().positive(),
});

export const planMissionSchema = z
  .object({ expectedVersion: z.number().int().positive() })
  .strict();

export const repairMissionSchema = z
  .object({ expectedVersion: z.number().int().positive() })
  .strict();

export function validationErrorResponse(error: z.ZodError): Response {
  return Response.json(
    {
      error: {
        code: "INVALID_REQUEST",
        message: "Request body is invalid",
        details: z.treeifyError(error),
      },
    },
    { status: 400 },
  );
}
