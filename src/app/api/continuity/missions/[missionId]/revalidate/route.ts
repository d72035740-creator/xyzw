import { z } from "zod";import { continuityService } from "@/continuity/continuity-service";import { continuityErrorResponse } from "@/continuity/types";
const schema=z.object({expectedVersion:z.number().int().positive()}).strict();
export async function POST(request:Request,{params}:{params:Promise<{missionId:string}>}){try{const body=schema.parse(await request.json());const {missionId}=await params;return Response.json(await continuityService.revalidate(missionId,body.expectedVersion));}catch(error){return continuityErrorResponse(error);}}
