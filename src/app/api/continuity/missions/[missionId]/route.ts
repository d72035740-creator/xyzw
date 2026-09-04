import { continuityService } from "@/continuity/continuity-service";
export async function GET(_:Request,{params}:{params:Promise<{missionId:string}>}){const {missionId}=await params;const view=await continuityService.getWithRepairs(missionId);return view?Response.json(view):Response.json({error:{code:"MISSION_NOT_FOUND",message:"Mission not found"}},{status:404});}
