import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://missionpay:missionpay@localhost:5432/missionpay";

const globalDatabase = globalThis as unknown as { missionPaySql?: ReturnType<typeof postgres> };
const reuseDevelopmentConnection = process.env.NODE_ENV === "development";

export const sqlClient =
  (reuseDevelopmentConnection ? globalDatabase.missionPaySql : undefined) ??
  postgres(databaseUrl, {
    max: 10,
    prepare: false,
  });

if (reuseDevelopmentConnection) {
  globalDatabase.missionPaySql = sqlClient;
}

export const db = drizzle(sqlClient, { schema });
export type Database = typeof db;
