SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "provider_accounts" DROP CONSTRAINT "provider_accounts_provider_check";--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_provider_check" CHECK ("provider_accounts"."provider" IN ('fake', 'paddle', 'stripe'));--> statement-breakpoint
INSERT INTO "provider_accounts" ("id", "project_id", "provider", "status", "credentials_ref")
VALUES ('5e3d0c1a-0b7e-4c52-9a51-3f0f6c2d7a05'::uuid, '5e3d0c1a-0b7e-4c52-9a51-3f0f6c2d7a01'::uuid, 'stripe', 'disabled', 'env:STRIPE')
ON CONFLICT ("id") DO NOTHING;
