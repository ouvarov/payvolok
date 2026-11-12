ALTER TABLE "payments" ADD COLUMN "reconcile_after" timestamp with time zone DEFAULT (clock_timestamp() + interval '600 seconds');--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "reconcile_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "idempotency_keys_created_at_idx" ON "idempotency_keys" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "payments_reconcile_after_idx" ON "payments" USING btree ("reconcile_after") WHERE "payments"."status" IN ('created', 'pending', 'succeeded', 'partially_refunded');--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_reconcile_attempts_check" CHECK ("payments"."reconcile_attempts" >= 0);