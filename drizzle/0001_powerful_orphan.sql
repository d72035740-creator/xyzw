ALTER TYPE "public"."reservation_status" ADD VALUE 'INVALID' BEFORE 'COMMITTED';--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "code" varchar(8);--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "merchant_id" uuid;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "offer_version" integer;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "offer_available" boolean;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "offers_code_uidx" ON "offers" USING btree ("code");--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_offer_version_positive" CHECK ("reservations"."offer_version" IS NULL OR "reservations"."offer_version" > 0);