CREATE TABLE "candidate_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"need_id" text NOT NULL,
	"offer_snapshot_id" uuid NOT NULL,
	"assessment_json" jsonb NOT NULL,
	"utility_score" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_assessments_utility_range" CHECK ("candidate_assessments"."utility_score" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "decision_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"profile" text NOT NULL,
	"weights_json" jsonb NOT NULL,
	"portfolios_json" jsonb NOT NULL,
	"selected_portfolio" text NOT NULL,
	"status" text DEFAULT 'SUCCEEDED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"need_id" text NOT NULL,
	"offer_snapshot_id" uuid NOT NULL,
	"type" text NOT NULL,
	"source_name" text NOT NULL,
	"source_url" text,
	"title" text NOT NULL,
	"snippet" text,
	"evidence_mode" text DEFAULT 'SEARCH_EVIDENCE' NOT NULL,
	"product_identity_confidence" text NOT NULL,
	"extracted_facts_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sentiment_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "candidate_assessments" ADD CONSTRAINT "candidate_assessments_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_assessments" ADD CONSTRAINT "candidate_assessments_offer_snapshot_id_market_offer_snapshots_id_fk" FOREIGN KEY ("offer_snapshot_id") REFERENCES "public"."market_offer_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_runs" ADD CONSTRAINT "decision_runs_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_evidence" ADD CONSTRAINT "product_evidence_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_evidence" ADD CONSTRAINT "product_evidence_offer_snapshot_id_market_offer_snapshots_id_fk" FOREIGN KEY ("offer_snapshot_id") REFERENCES "public"."market_offer_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_assessments_snapshot_uidx" ON "candidate_assessments" USING btree ("offer_snapshot_id");--> statement-breakpoint
CREATE INDEX "candidate_assessments_mission_need_idx" ON "candidate_assessments" USING btree ("mission_id","need_id");--> statement-breakpoint
CREATE INDEX "decision_runs_mission_idx" ON "decision_runs" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX "product_evidence_mission_need_idx" ON "product_evidence" USING btree ("mission_id","need_id");--> statement-breakpoint
CREATE INDEX "product_evidence_snapshot_idx" ON "product_evidence" USING btree ("offer_snapshot_id");