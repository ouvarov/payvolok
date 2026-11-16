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
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_id_provider_unique" UNIQUE("id","provider");--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_provider_account_fk" FOREIGN KEY ("provider_account_id","provider") REFERENCES "public"."provider_accounts"("id","provider") ON DELETE no action ON UPDATE no action NOT VALID;
