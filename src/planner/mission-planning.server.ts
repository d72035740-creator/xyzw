import "server-only";
import { MockMerchantAdapter } from "@/commerce/mock-merchant-adapter";
import { db } from "@/db/client";
import { MissionAuthority } from "@/services/mission-authority";
import { PostgresMissionAuthorityStore } from "@/services/postgres-authority-store";
import { MissionPlanningService } from "./mission-planning-service";
import { MockMissionPlanner } from "./mock-mission-planner";
import { OpenAIMissionPlanner } from "./openai-mission-planner";

const planner =
  process.env.MISSIONPAY_PLANNER_PROVIDER === "mock"
    ? new MockMissionPlanner()
    : new OpenAIMissionPlanner();
const authority = new MissionAuthority(new PostgresMissionAuthorityStore(db));

export const missionPlanningService = new MissionPlanningService(
  planner,
  new MockMerchantAdapter(db),
  authority,
  db,
);
