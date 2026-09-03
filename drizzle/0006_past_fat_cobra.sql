CREATE TABLE "continuity_missions" (
	"mission_id" uuid PRIMARY KEY NOT NULL,
	"spec" jsonb NOT NULL,
	"market_mode" text NOT NULL,
	"outcome_status" text DEFAULT 'PLANNED' NOT NULL,
	"repair_allowance_paise" integer DEFAULT 0 NOT NULL,
	"allow_automatic_substitution" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "continuity_repair_allowance_nonnegative" CHECK ("continuity_missions"."repair_allowance_paise" >= 0),
	CONSTRAINT "continuity_market_mode_valid" CHECK ("continuity_missions"."market_mode" IN ('live', 'sandbox'))
);
--> statement-breakpoint
CREATE TABLE "continuity_selections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"need_id" text NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"status" text DEFAULT 'SELECTED' NOT NULL,
	"reserved_price_paise" integer NOT NULL,
	"replaced_selection_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "continuity_selection_price_positive" CHECK ("continuity_selections"."reserved_price_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "market_offer_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"need_id" text NOT NULL,
	"source_provider" text NOT NULL,
	"external_id" text,
	"source_url" text,
	"merchant_name" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"price_paise" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'INR' NOT NULL,
	"availability" text NOT NULL,
	"attributes_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reversibility_json" jsonb,
	"evidence_json" jsonb,
	"observed_at" timestamp with time zone NOT NULL,
	"source_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_offer_snapshots_price_positive" CHECK ("market_offer_snapshots"."price_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "market_searches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"need_id" text NOT NULL,
	"connector_id" text NOT NULL,
	"query" text NOT NULL,
	"status" text NOT NULL,
	"result_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mission_outcome_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"need_id" text,
	"type" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "continuity_missions" ADD CONSTRAINT "continuity_missions_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "continuity_selections" ADD CONSTRAINT "continuity_selections_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "continuity_selections" ADD CONSTRAINT "continuity_selections_snapshot_id_market_offer_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."market_offer_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_offer_snapshots" ADD CONSTRAINT "market_offer_snapshots_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_searches" ADD CONSTRAINT "market_searches_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_outcome_events" ADD CONSTRAINT "mission_outcome_events_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "continuity_selections_mission_idx" ON "continuity_selections" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX "market_offer_snapshots_mission_need_idx" ON "market_offer_snapshots" USING btree ("mission_id","need_id");--> statement-breakpoint
CREATE INDEX "market_searches_mission_idx" ON "market_searches" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX "mission_outcome_events_mission_idx" ON "mission_outcome_events" USING btree ("mission_id");
--> statement-breakpoint
CREATE FUNCTION reject_mission_outcome_event_mutation() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'mission_outcome_events is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER mission_outcome_events_append_only
BEFORE UPDATE OR DELETE ON "mission_outcome_events"
FOR EACH ROW EXECUTE FUNCTION reject_mission_outcome_event_mutation();
