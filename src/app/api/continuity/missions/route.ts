import { z } from "zod";
import { continuityService } from "@/continuity/continuity-service";
import { continuityErrorResponse, withoutPreciseLocation } from "@/continuity/types";
const schema=z.object({missionId:z.string().uuid(),missionVersion:z.number().int().positive()}).strict();
export async function POST(request:Request){try{const parsed=schema.safeParse(await request.json());if(!parsed.success)return Response.json({error:{code:"INVALID_REQUEST",message:"Mission request is invalid"}},{status:400});return Response.json(withoutPreciseLocation(await continuityService.build(parsed.data)),{status:201});}catch(error){return continuityErrorResponse(error);}}
