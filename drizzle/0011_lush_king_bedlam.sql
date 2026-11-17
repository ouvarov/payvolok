SET LOCAL lock_timeout = '3s';--> statement-breakpoint
INSERT INTO "provider_accounts" ("id", "project_id", "provider", "credentials_ref")
SELECT '5e3d0c1a-0b7e-4c52-9a51-3f0f6c2d7a03'::uuid, '5e3d0c1a-0b7e-4c52-9a51-3f0f6c2d7a01'::uuid, 'fake', 'env:FAKE'
WHERE EXISTS (SELECT 1 FROM "payments" WHERE "provider" = 'fake')
	OR EXISTS (SELECT 1 FROM "refunds" WHERE "provider" = 'fake')
	OR EXISTS (SELECT 1 FROM "webhook_events" WHERE "provider" = 'fake')
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
UPDATE "payments" p SET "provider_account_id" = a."id" FROM "provider_accounts" a WHERE a."project_id" = p."project_id" AND a."provider" = p."provider" AND p."provider_account_id" IS NULL;--> statement-breakpoint
UPDATE "refunds" r SET "provider_account_id" = p."provider_account_id" FROM "payments" p WHERE p."id" = r."payment_id" AND r."provider_account_id" IS NULL AND p."provider_account_id" IS NOT NULL;--> statement-breakpoint
UPDATE "webhook_events" w SET "provider_account_id" = a."id" FROM "provider_accounts" a WHERE a."project_id" = '5e3d0c1a-0b7e-4c52-9a51-3f0f6c2d7a01' AND a."provider" = w."provider" AND w."provider_account_id" IS NULL;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "provider_account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ALTER COLUMN "provider_account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_events" ALTER COLUMN "provider_account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "project_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "refunds" ALTER COLUMN "project_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ALTER COLUMN "project_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_provider_provider_payment_id_unique";--> statement-breakpoint
ALTER TABLE "refunds" DROP CONSTRAINT "refunds_provider_provider_refund_id_unique";--> statement-breakpoint
DROP INDEX "webhook_events_provider_dedup_key_unique";--> statement-breakpoint
CREATE INDEX "payments_provider_provider_payment_id_idx" ON "payments" USING btree ("provider","provider_payment_id") WHERE "payments"."provider_payment_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "idempotency_keys" DROP CONSTRAINT "idempotency_keys_scope_key_pk";--> statement-breakpoint
DROP INDEX "idempotency_keys_project_id_scope_key_unique";--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_project_id_scope_key_pk" PRIMARY KEY("project_id","scope","key");--> statement-breakpoint
ALTER TABLE "payments" VALIDATE CONSTRAINT "payments_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "payments" VALIDATE CONSTRAINT "payments_provider_account_fk";--> statement-breakpoint
ALTER TABLE "refunds" VALIDATE CONSTRAINT "refunds_payment_project_account_fk";--> statement-breakpoint
ALTER TABLE "idempotency_keys" VALIDATE CONSTRAINT "idempotency_keys_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "idempotency_keys" VALIDATE CONSTRAINT "idempotency_keys_payment_project_fk";--> statement-breakpoint
ALTER TABLE "webhook_events" VALIDATE CONSTRAINT "webhook_events_provider_account_id_provider_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "webhook_events" VALIDATE CONSTRAINT "webhook_events_provider_account_fk";
