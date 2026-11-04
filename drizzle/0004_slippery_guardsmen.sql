CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_refund_id" text,
	"origin" text NOT NULL,
	"status" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "refunds_provider_provider_refund_id_unique" UNIQUE("provider","provider_refund_id"),
	CONSTRAINT "refunds_origin_check" CHECK ("refunds"."origin" IN ('api', 'admin', 'demo', 'provider')),
	CONSTRAINT "refunds_status_check" CHECK ("refunds"."status" IN ('pending', 'succeeded', 'failed')),
	CONSTRAINT "refunds_amount_minor_check" CHECK ("refunds"."amount_minor" > 0),
	CONSTRAINT "refunds_currency_check" CHECK ("refunds"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_origin_check";--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refunds_payment_id_created_at_id_idx" ON "refunds" USING btree ("payment_id","created_at","id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_origin_check" CHECK ("payments"."origin" IN ('api', 'admin', 'demo', 'provider'));