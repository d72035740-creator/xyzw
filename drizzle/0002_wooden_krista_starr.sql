CREATE TYPE "public"."agent_run_status" AS ENUM('STARTED', 'SUCCEEDED', 'REJECTED', 'FAILED');--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"mission_version" integer NOT NULL,
	"request_key" text,
	"planner_id" text NOT NULL,
	"model_id" text,
	"input_snapshot" jsonb NOT NULL,
	"raw_output" jsonb,
	"validated_proposal" jsonb,
	"status" "agent_run_status" DEFAULT 'STARTED' NOT NULL,
	"error_code" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "agent_runs_mission_version_positive" CHECK ("agent_runs"."mission_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "constraints" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "vegetarian" boolean;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "serves_people" integer;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_mission_id_idx" ON "agent_runs" USING btree ("mission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_mission_request_key_uidx" ON "agent_runs" USING btree ("mission_id","request_key");--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_serves_people_positive" CHECK ("offers"."serves_people" IS NULL OR "offers"."serves_people" > 0);