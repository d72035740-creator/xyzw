CREATE TYPE "public"."repair_attempt_status" AS ENUM('STARTED', 'SUCCEEDED', 'REJECTED', 'FAILED');--> statement-breakpoint
CREATE TABLE "mission_repair_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"starting_version" integer NOT NULL,
	"request_key" text,
	"planner_id" text NOT NULL,
	"model_id" text,
	"input_snapshot" jsonb NOT NULL,
	"raw_proposal" jsonb,
	"validated_repair" jsonb,
	"preserved_reservation_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"released_reservation_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"replacement_reservation_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"previous_reserved_amount" integer NOT NULL,
	"final_reserved_amount" integer,
	"status" "repair_attempt_status" DEFAULT 'STARTED' NOT NULL,
	"error_code" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "mission_repair_attempts_starting_version_positive" CHECK ("mission_repair_attempts"."starting_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "offer_vegetarian" boolean;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "offer_serves_people" integer;--> statement-breakpoint
ALTER TABLE "mission_repair_attempts" ADD CONSTRAINT "mission_repair_attempts_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mission_repair_attempts_mission_id_idx" ON "mission_repair_attempts" USING btree ("mission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mission_repair_attempts_mission_request_key_uidx" ON "mission_repair_attempts" USING btree ("mission_id","request_key");--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_offer_serves_people_positive" CHECK ("reservations"."offer_serves_people" IS NULL OR "reservations"."offer_serves_people" > 0);