import "server-only";
import { MissionAuthority } from "./mission-authority";
import { PostgresMissionAuthorityStore } from "./postgres-authority-store";

export const missionAuthority = new MissionAuthority(new PostgresMissionAuthorityStore());
