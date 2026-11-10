CREATE TABLE "idempotency_keys" (
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text NOT NULL,
	"payment_id" uuid,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "idempotency_keys_scope_key_pk" PRIMARY KEY("scope","key"),
	CONSTRAINT "idempotency_keys_scope_check" CHECK ("idempotency_keys"."scope" IN ('api:create_payment', 'api:create_refund')),
	CONSTRAINT "idempotency_keys_status_check" CHECK ("idempotency_keys"."status" IN ('in_progress', 'completed')),
	CONSTRAINT "idempotency_keys_request_hash_check" CHECK ("idempotency_keys"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "idempotency_keys_response_status_check" CHECK (("idempotency_keys"."status" = 'completed') = ("idempotency_keys"."response_status" IS NOT NULL)),
	CONSTRAINT "idempotency_keys_response_body_check" CHECK (("idempotency_keys"."status" = 'completed') = ("idempotency_keys"."response_body" IS NOT NULL)),
	CONSTRAINT "idempotency_keys_completed_at_check" CHECK (("idempotency_keys"."status" = 'completed') = ("idempotency_keys"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idempotency_keys_payment_id_in_progress_idx" ON "idempotency_keys" USING btree ("payment_id") WHERE "idempotency_keys"."status" = 'in_progress';