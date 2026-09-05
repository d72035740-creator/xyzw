CREATE TABLE "mission_compilation_cache" (
	"cache_key" text PRIMARY KEY NOT NULL,
	"normalized_goal" text NOT NULL,
	"maximum_authority_paise" integer NOT NULL,
	"repair_allowance_paise" integer NOT NULL,
	"resolved_location" text,
	"mission_spec" jsonb NOT NULL,
	"compiler_provider" text NOT NULL,
	"compiler_model" text NOT NULL,
	"semantic_validation_status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mission_compilation_cache_authority_positive" CHECK ("mission_compilation_cache"."maximum_authority_paise" > 0),
	CONSTRAINT "mission_compilation_cache_repair_nonnegative" CHECK ("mission_compilation_cache"."repair_allowance_paise" >= 0),
	CONSTRAINT "mission_compilation_cache_semantic_valid" CHECK ("mission_compilation_cache"."semantic_validation_status" = 'VALID')
);
--> statement-breakpoint
CREATE INDEX "mission_compilation_cache_created_idx" ON "mission_compilation_cache" USING btree ("created_at");
