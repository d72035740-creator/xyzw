import { eq } from "drizzle-orm";
import { db, type Database } from "@/db/client";
import { missionEvents, missionItems, missions, reservations } from "@/db/schema";
import type { MerchantCategory } from "./authority-store";

export interface CreateMissionInput {
  goal: string;
  budgetAmount: number;
  deadline: Date;
  requiredCategories: MerchantCategory[];
  constraints?: { people?: number; vegetarian?: boolean };
}

export class MissionService {
  constructor(private readonly database: Database = db) {}

  async create(input: CreateMissionInput) {
    return this.database.transaction(async (transaction) => {
      const [mission] = await transaction
        .insert(missions)
        .values({
          goal: input.goal,
          budgetAmount: input.budgetAmount,
          deadline: input.deadline,
          constraints: input.constraints ?? {},
        })
        .returning();

      await transaction.insert(missionItems).values(
        input.requiredCategories.map((category) => ({ missionId: mission.id, category })),
      );
      await transaction.insert(missionEvents).values({
        missionId: mission.id,
        type: "MISSION_CREATED",
        missionVersion: mission.version,
        data: { requiredCategories: input.requiredCategories },
      });

      return mission;
    });
  }

  async get(missionId: string) {
    const [mission] = await this.database.select().from(missions).where(eq(missions.id, missionId));
    if (!mission) return null;

    const [items, activeReservations] = await Promise.all([
      this.database.select().from(missionItems).where(eq(missionItems.missionId, missionId)),
      this.database.select().from(reservations).where(eq(reservations.missionId, missionId)),
    ]);
    return {
      ...mission,
      remainingAmount: mission.budgetAmount - mission.reservedAmount - mission.committedAmount,
      items,
      reservations: activeReservations,
    };
  }
}
