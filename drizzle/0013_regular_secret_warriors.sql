SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "idempotency_keys" DROP CONSTRAINT "idempotency_keys_scope_check";--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_scope_check" CHECK ("idempotency_keys"."scope" IN ('api:create_payment', 'api:create_refund', 'demo:create_payment', 'demo:create_refund'));--> statement-breakpoint
CREATE INDEX "payments_demo_created_at_idx" ON "payments" USING btree ("created_at") WHERE "payments"."origin" = 'demo';
