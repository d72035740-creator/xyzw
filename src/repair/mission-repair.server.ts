import "server-only";
import { MockMerchantAdapter } from "@/commerce/mock-merchant-adapter";
import { db } from "@/db/client";
import { MissionAuthority } from "@/services/mission-authority";
import { PostgresMissionAuthorityStore } from "@/services/postgres-authority-store";
import { MissionRepairService } from "./mission-repair-service";
import { MockMissionRepairPlanner } from "./mock-mission-repair-planner";

const authority = new MissionAuthority(new PostgresMissionAuthorityStore(db));

export const missionRepairService = new MissionRepairService(
  new MockMissionRepairPlanner(),
  new MockMerchantAdapter(db),
  authority,
  db,
);
