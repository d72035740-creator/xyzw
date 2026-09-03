CREATE TYPE "public"."merchant_category" AS ENUM('CAKE', 'FLOWERS', 'RESTAURANT');--> statement-breakpoint
CREATE TYPE "public"."mission_item_status" AS ENUM('REQUIRED', 'RESERVED', 'VALID', 'INVALID');--> statement-breakpoint
CREATE TYPE "public"."mission_status" AS ENUM('DRAFT', 'PLANNING', 'PROPOSED', 'RESERVING', 'READY_TO_COMMIT', 'PAYMENT_PENDING', 'PAID', 'DISTRIBUTING', 'COMPLETED', 'INVALIDATED', 'REPLANNING', 'PAYMENT_FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('ACTIVE', 'RELEASED', 'COMMITTED', 'EXPIRED');--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"category" "merchant_category" NOT NULL,
	"is_simulated" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mission_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"type" text NOT NULL,
	"mission_version" integer NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mission_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"category" "merchant_category" NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"reservation_id" uuid,
	"status" "mission_item_status" DEFAULT 'REQUIRED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "missions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goal" text NOT NULL,
	"budget_amount" integer NOT NULL,
	"reserved_amount" integer DEFAULT 0 NOT NULL,
	"committed_amount" integer DEFAULT 0 NOT NULL,
	"currency" varchar(3) DEFAULT 'INR' NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"status" "mission_status" DEFAULT 'DRAFT' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "missions_budget_positive" CHECK ("missions"."budget_amount" > 0),
	CONSTRAINT "missions_reserved_nonnegative" CHECK ("missions"."reserved_amount" >= 0),
	CONSTRAINT "missions_committed_nonnegative" CHECK ("missions"."committed_amount" >= 0),
	CONSTRAINT "missions_authority_within_budget" CHECK ("missions"."reserved_amount" + "missions"."committed_amount" <= "missions"."budget_amount"),
	CONSTRAINT "missions_version_positive" CHECK ("missions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"amount" integer NOT NULL,
	"ready_at" timestamp with time zone NOT NULL,
	"available" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offers_amount_positive" CHECK ("offers"."amount" > 0),
	CONSTRAINT "offers_version_positive" CHECK ("offers"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"status" "reservation_status" DEFAULT 'ACTIVE' NOT NULL,
	"expires_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservations_amount_positive" CHECK ("reservations"."amount" > 0),
	CONSTRAINT "reservations_version_positive" CHECK ("reservations"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "mission_events" ADD CONSTRAINT "mission_events_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_items" ADD CONSTRAINT "mission_items_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_items" ADD CONSTRAINT "mission_items_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merchants_name_uidx" ON "merchants" USING btree ("name");--> statement-breakpoint
CREATE INDEX "mission_events_mission_id_idx" ON "mission_events" USING btree ("mission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mission_items_mission_category_uidx" ON "mission_items" USING btree ("mission_id","category");--> statement-breakpoint
CREATE INDEX "offers_merchant_id_idx" ON "offers" USING btree ("merchant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "offers_merchant_name_uidx" ON "offers" USING btree ("merchant_id","name");--> statement-breakpoint
CREATE INDEX "reservations_mission_id_idx" ON "reservations" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX "reservations_offer_id_idx" ON "reservations" USING btree ("offer_id");
--> statement-breakpoint
CREATE FUNCTION reject_mission_event_mutation() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'mission_events is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER mission_events_append_only
BEFORE UPDATE OR DELETE ON "mission_events"
FOR EACH ROW EXECUTE FUNCTION reject_mission_event_mutation();
