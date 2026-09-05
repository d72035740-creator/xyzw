import { and, eq, gt } from "drizzle-orm";
import { db, type Database } from "@/db/client";
import { missionCompilationCache } from "@/db/schema";
import { missionSpecSchema, type MissionSpec } from "./types";

export const VALID_COMPILATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface CachedMissionCompilation {
  cacheKey: string;
  normalizedGoal: string;
  maximumAuthorityPaise: number;
  repairAllowancePaise: number;
  resolvedLocation: string | null;
  missionSpec: MissionSpec;
  compilerProvider: string;
  compilerModel: string;
  createdAt: Date;
}

export interface MissionCompilationCache {
  getValid(cacheKey: string): Promise<CachedMissionCompilation | null>;
  putValid(entry: CachedMissionCompilation): Promise<void>;
}

export class NoopMissionCompilationCache implements MissionCompilationCache {
  async getValid(): Promise<null> { return null; }
  async putValid(): Promise<void> {}
}

export class PostgresMissionCompilationCache implements MissionCompilationCache {
  constructor(private readonly database: Database = db, private readonly now: () => Date = () => new Date()) {}

  async getValid(cacheKey: string): Promise<CachedMissionCompilation | null> {
    const [entry] = await this.database.select().from(missionCompilationCache).where(and(
      eq(missionCompilationCache.cacheKey, cacheKey),
      eq(missionCompilationCache.semanticValidationStatus, "VALID"),
      gt(missionCompilationCache.createdAt, new Date(this.now().getTime() - VALID_COMPILATION_CACHE_TTL_MS)),
    )).limit(1);
    if (!entry) return null;
    const parsed = missionSpecSchema.safeParse(entry.missionSpec);
    return parsed.success ? { ...entry, resolvedLocation: entry.resolvedLocation ?? null, missionSpec: parsed.data } : null;
  }

  async putValid(entry: CachedMissionCompilation): Promise<void> {
    await this.database.insert(missionCompilationCache).values({
      cacheKey: entry.cacheKey, normalizedGoal: entry.normalizedGoal,
      maximumAuthorityPaise: entry.maximumAuthorityPaise, repairAllowancePaise: entry.repairAllowancePaise,
      resolvedLocation: entry.resolvedLocation, missionSpec: entry.missionSpec,
      compilerProvider: entry.compilerProvider, compilerModel: entry.compilerModel,
      semanticValidationStatus: "VALID", createdAt: entry.createdAt,
    }).onConflictDoUpdate({ target: missionCompilationCache.cacheKey, set: {
      missionSpec: entry.missionSpec, compilerProvider: entry.compilerProvider,
      compilerModel: entry.compilerModel, semanticValidationStatus: "VALID", createdAt: entry.createdAt,
    } });
  }
}
