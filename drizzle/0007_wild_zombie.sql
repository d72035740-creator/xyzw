CREATE TABLE "continuity_repair_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"affected_need_id" text NOT NULL,
	"original_selection_id" uuid NOT NULL,
	"replacement_snapshot_id" uuid NOT NULL,
	"original_payment_order_id" uuid NOT NULL,
	"old_price_paise" integer NOT NULL,
	"new_price_paise" integer NOT NULL,
	"additional_spend_paise" integer DEFAULT 0 NOT NULL,
	"authorized_additional_spend_paise" integer DEFAULT 0 NOT NULL,
	"refund_required_paise" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'PROPOSED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "continuity_repair_amounts_nonnegative" CHECK ("continuity_repair_attempts"."additional_spend_paise" >= 0 AND "continuity_repair_attempts"."authorized_additional_spend_paise" >= 0 AND "continuity_repair_attempts"."refund_required_paise" >= 0),
	CONSTRAINT "continuity_repair_prices_positive" CHECK ("continuity_repair_attempts"."old_price_paise" > 0 AND "continuity_repair_attempts"."new_price_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "continuity_repair_payment_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"repair_payment_order_id" uuid NOT NULL,
	"provider_payment_id" text NOT NULL,
	"provider_order_id" text NOT NULL,
	"callback_verified" boolean DEFAULT false NOT NULL,
	"provider_status" text,
	"amount" integer NOT NULL,
	"status" text DEFAULT 'RECEIVED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "continuity_repair_payment_attempt_amount_positive" CHECK ("continuity_repair_payment_attempts"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "continuity_repair_payment_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"repair_attempt_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'INR' NOT NULL,
	"provider" text DEFAULT 'razorpay' NOT NULL,
	"provider_order_id" text,
	"idempotency_key" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "continuity_repair_payment_orders_provider_order_id_unique" UNIQUE("provider_order_id"),
	CONSTRAINT "continuity_repair_payment_order_amount_positive" CHECK ("continuity_repair_payment_orders"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "continuity_repair_attempts" ADD CONSTRAINT "continuity_repair_attempts_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "continuity_repair_attempts" ADD CONSTRAINT "continuity_repair_attempts_original_selection_id_continuity_selections_id_fk" FOREIGN KEY ("original_selection_id") REFERENCES "public"."continuity_selections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "continuity_repair_attempts" ADD CONSTRAINT "continuity_repair_attempts_replacement_snapshot_id_market_offer_snapshots_id_fk" FOREIGN KEY ("replacement_snapshot_id") REFERENCES "public"."market_offer_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "continuity_repair_attempts" ADD CONSTRAINT "continuity_repair_attempts_original_payment_order_id_mission_payment_orders_id_fk" FOREIGN KEY ("original_payment_order_id") REFERENCES "public"."mission_payment_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "continuity_repair_payment_attempts" ADD CONSTRAINT "continuity_repair_payment_attempts_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "continuity_repair_payment_attempts" ADD CONSTRAINT "continuity_repair_payment_attempts_repair_payment_order_id_continuity_repair_payment_orders_id_fk" FOREIGN KEY ("repair_payment_order_id") REFERENCES "public"."continuity_repair_payment_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "continuity_repair_payment_orders" ADD CONSTRAINT "continuity_repair_payment_orders_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "continuity_repair_payment_orders" ADD CONSTRAINT "continuity_repair_payment_orders_repair_attempt_id_continuity_repair_attempts_id_fk" FOREIGN KEY ("repair_attempt_id") REFERENCES "public"."continuity_repair_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "continuity_repair_attempts_mission_idx" ON "continuity_repair_attempts" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX "continuity_repair_payment_attempts_mission_idx" ON "continuity_repair_payment_attempts" USING btree ("mission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "continuity_repair_payment_attempts_provider_payment_uidx" ON "continuity_repair_payment_attempts" USING btree ("provider_payment_id");--> statement-breakpoint
CREATE INDEX "continuity_repair_payment_orders_mission_idx" ON "continuity_repair_payment_orders" USING btree ("mission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "continuity_repair_payment_orders_attempt_uidx" ON "continuity_repair_payment_orders" USING btree ("repair_attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "continuity_repair_payment_orders_request_uidx" ON "continuity_repair_payment_orders" USING btree ("mission_id","idempotency_key");