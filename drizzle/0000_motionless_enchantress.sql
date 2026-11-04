CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text NOT NULL,
	"webhook_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_events_webhook_event_id_payment_id_to_status_unique" UNIQUE("webhook_event_id","payment_id","to_status"),
	CONSTRAINT "payment_events_from_status_check" CHECK ("payment_events"."from_status" IN ('created', 'pending', 'succeeded', 'partially_refunded', 'refunded', 'failed', 'expired')),
	CONSTRAINT "payment_events_to_status_check" CHECK ("payment_events"."to_status" IN ('created', 'pending', 'succeeded', 'partially_refunded', 'refunded', 'failed', 'expired')),
	CONSTRAINT "payment_events_outcome_check" CHECK ("payment_events"."outcome" IN ('applied', 'stale', 'conflict'))
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_payment_id" text,
	"purpose" text NOT NULL,
	"origin" text NOT NULL,
	"status" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_provider_provider_payment_id_unique" UNIQUE("provider","provider_payment_id"),
	CONSTRAINT "payments_purpose_check" CHECK ("payments"."purpose" IN ('one_off', 'subscription_initial', 'subscription_renewal')),
	CONSTRAINT "payments_origin_check" CHECK ("payments"."origin" IN ('api', 'admin', 'demo')),
	CONSTRAINT "payments_status_check" CHECK ("payments"."status" IN ('created', 'pending', 'succeeded', 'partially_refunded', 'refunded', 'failed', 'expired')),
	CONSTRAINT "payments_amount_minor_check" CHECK ("payments"."amount_minor" >= 0),
	CONSTRAINT "payments_currency_check" CHECK ("payments"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_events_payment_id_created_at_id_idx" ON "payment_events" USING btree ("payment_id","created_at","id");