import { z } from "zod";import { continuityService } from "@/continuity/continuity-service";import { continuityErrorResponse } from "@/continuity/types";
const schema=z.object({needId:z.string().min(1),expectedVersion:z.number().int().positive()}).strict();
export async function POST(request:Request,{params}:{params:Promise<{missionId:string}>}){try{const body=schema.parse(await request.json());const {missionId}=await params;return Response.json(await continuityService.replaceFresh(missionId,body.needId,body.expectedVersion));}catch(error){return continuityErrorResponse(error);}}
