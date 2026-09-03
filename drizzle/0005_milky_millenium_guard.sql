CREATE TYPE "public"."mission_payment_order_status" AS ENUM('ACTIVE', 'CAPTURED', 'FAILED', 'EXPIRED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."payment_attempt_status" AS ENUM('RECEIVED', 'VERIFIED', 'CAPTURED', 'FAILED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."webhook_processing_status" AS ENUM('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');--> statement-breakpoint
CREATE TABLE "mission_payment_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"mission_version" integer NOT NULL,
	"amount" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'INR' NOT NULL,
	"provider" text DEFAULT 'razorpay' NOT NULL,
	"provider_order_id" text,
	"idempotency_key" text,
	"status" "mission_payment_order_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mission_payment_orders_provider_order_id_unique" UNIQUE("provider_order_id"),
	CONSTRAINT "mission_payment_orders_amount_positive" CHECK ("mission_payment_orders"."amount" > 0),
	CONSTRAINT "mission_payment_orders_version_positive" CHECK ("mission_payment_orders"."mission_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"mission_payment_order_id" uuid NOT NULL,
	"provider_payment_id" text,
	"provider_order_id" text NOT NULL,
	"callback_verified" boolean DEFAULT false NOT NULL,
	"provider_status" text,
	"amount" integer NOT NULL,
	"status" "payment_attempt_status" DEFAULT 'RECEIVED' NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_attempts_amount_positive" CHECK ("payment_attempts"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "razorpay_webhook_events" (
	"provider_event_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"processing_status" "webhook_processing_status" DEFAULT 'RECEIVED' NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mission_payment_orders" ADD CONSTRAINT "mission_payment_orders_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_mission_payment_order_id_mission_payment_orders_id_fk" FOREIGN KEY ("mission_payment_order_id") REFERENCES "public"."mission_payment_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mission_payment_orders_mission_id_idx" ON "mission_payment_orders" USING btree ("mission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mission_payment_orders_mission_version_uidx" ON "mission_payment_orders" USING btree ("mission_id","mission_version");--> statement-breakpoint
CREATE UNIQUE INDEX "mission_payment_orders_mission_request_key_uidx" ON "mission_payment_orders" USING btree ("mission_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "payment_attempts_mission_id_idx" ON "payment_attempts" USING btree ("mission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_provider_payment_uidx" ON "payment_attempts" USING btree ("provider_payment_id");