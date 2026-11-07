CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"dedup_key" text NOT NULL,
	"status" text NOT NULL,
	"signature_valid" boolean NOT NULL,
	"raw_body" "bytea",
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"event_types" text[] DEFAULT '{}' NOT NULL,
	"payment_ids" uuid[] DEFAULT '{}' NOT NULL,
	"failure_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"replay_of" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "webhook_events_status_check" CHECK ("webhook_events"."status" IN ('received', 'processed', 'ignored', 'failed')),
	CONSTRAINT "webhook_events_attempts_check" CHECK ("webhook_events"."attempts" >= 0),
	CONSTRAINT "webhook_events_invalid_signature_ignored_check" CHECK ("webhook_events"."signature_valid" OR "webhook_events"."status" = 'ignored'),
	CONSTRAINT "webhook_events_raw_body_check" CHECK (("webhook_events"."raw_body" IS NOT NULL) = ("webhook_events"."signature_valid" AND "webhook_events"."replay_of" IS NULL)),
	CONSTRAINT "webhook_events_next_attempt_at_check" CHECK (("webhook_events"."status" = 'received') = ("webhook_events"."next_attempt_at" IS NOT NULL)),
	CONSTRAINT "webhook_events_finished_at_check" CHECK (("webhook_events"."status" = 'received') = ("webhook_events"."finished_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "updated_at" SET DEFAULT clock_timestamp();--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_replay_of_webhook_events_id_fk" FOREIGN KEY ("replay_of") REFERENCES "public"."webhook_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_dedup_key_unique" ON "webhook_events" USING btree ("provider","dedup_key") WHERE "webhook_events"."replay_of" IS NULL;--> statement-breakpoint
CREATE INDEX "webhook_events_next_attempt_at_id_idx" ON "webhook_events" USING btree ("next_attempt_at","id") WHERE "webhook_events"."status" = 'received';--> statement-breakpoint
DELETE FROM "payment_events" WHERE "webhook_event_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_webhook_event_id_webhook_events_id_fk" FOREIGN KEY ("webhook_event_id") REFERENCES "public"."webhook_events"("id") ON DELETE no action ON UPDATE no action;