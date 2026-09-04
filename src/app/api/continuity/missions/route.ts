import { z } from "zod";
import { continuityService } from "@/continuity/continuity-service";
import { continuityErrorResponse, missionLocationInputSchema, withoutPreciseLocation } from "@/continuity/types";
const schema=z.object({goal:z.string().trim().min(3).max(2000),maximumAuthorityPaise:z.number().int().positive().optional(),location:missionLocationInputSchema.optional(),repairAllowancePaise:z.number().int().nonnegative().optional()}).strict();
export async function POST(request:Request){try{const parsed=schema.safeParse(await request.json());if(!parsed.success)return Response.json({error:{code:"INVALID_REQUEST",message:"Mission request is invalid"}},{status:400});return Response.json(withoutPreciseLocation(await continuityService.build(parsed.data)),{status:201});}catch(error){return continuityErrorResponse(error);}}
