SET LOCAL lock_timeout = '3s';--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"allowed_return_origins" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug"),
	CONSTRAINT "projects_slug_check" CHECK ("projects"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "projects_status_check" CHECK ("projects"."status" IN ('active', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "provider_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"credentials_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "provider_accounts_project_id_provider_unique" UNIQUE("project_id","provider"),
	CONSTRAINT "provider_accounts_id_project_id_provider_unique" UNIQUE("id","project_id","provider"),
	CONSTRAINT "provider_accounts_provider_check" CHECK ("provider_accounts"."provider" IN ('fake', 'paddle')),
	CONSTRAINT "provider_accounts_status_check" CHECK ("provider_accounts"."status" IN ('active', 'disabled')),
	CONSTRAINT "provider_accounts_credentials_ref_check" CHECK ("provider_accounts"."credentials_ref" ~ '^env:[A-Z][A-Z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash"),
	CONSTRAINT "api_keys_key_hash_check" CHECK ("api_keys"."key_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "api_keys_key_prefix_check" CHECK ("api_keys"."key_prefix" ~ '^pv_test_')
);
--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_project_id_idx" ON "api_keys" USING btree ("project_id");--> statement-breakpoint
INSERT INTO "projects" ("id", "slug", "name") VALUES ('5e3d0c1a-0b7e-4c52-9a51-3f0f6c2d7a01', 'payvolok-demo', 'PayVolok Demo');--> statement-breakpoint
INSERT INTO "provider_accounts" ("id", "project_id", "provider", "credentials_ref") VALUES ('5e3d0c1a-0b7e-4c52-9a51-3f0f6c2d7a02', '5e3d0c1a-0b7e-4c52-9a51-3f0f6c2d7a01', 'paddle', 'env:PADDLE');--> statement-breakpoint
INSERT INTO "provider_accounts" ("id", "project_id", "provider", "credentials_ref")
SELECT '5e3d0c1a-0b7e-4c52-9a51-3f0f6c2d7a03'::uuid, '5e3d0c1a-0b7e-4c52-9a51-3f0f6c2d7a01'::uuid, 'fake', 'env:FAKE'
WHERE EXISTS (SELECT 1 FROM "payments" WHERE "provider" = 'fake')
	OR EXISTS (SELECT 1 FROM "refunds" WHERE "provider" = 'fake')
	OR EXISTS (SELECT 1 FROM "webhook_events" WHERE "provider" = 'fake');--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "project_id" uuid DEFAULT '5e3d0c1a-0b7e-4c52-9a51-3f0f6c2d7a01' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "provider_account_id" uuid;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "project_id" uuid DEFAULT '5e3d0c1a-0b7e-4c52-9a51-3f0f6c2d7a01' NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "provider_account_id" uuid;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD COLUMN "project_id" uuid DEFAULT '5e3d0c1a-0b7e-4c52-9a51-3f0f6c2d7a01' NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "provider_account_id" uuid;--> statement-breakpoint
UPDATE "payments" p SET "provider_account_id" = a."id" FROM "provider_accounts" a WHERE a."project_id" = p."project_id" AND a."provider" = p."provider" AND p."provider_account_id" IS NULL;--> statement-breakpoint
UPDATE "refunds" r SET "provider_account_id" = p."provider_account_id" FROM "payments" p WHERE p."id" = r."payment_id" AND r."provider_account_id" IS NULL;--> statement-breakpoint
UPDATE "webhook_events" w SET "provider_account_id" = a."id" FROM "provider_accounts" a WHERE a."project_id" = '5e3d0c1a-0b7e-4c52-9a51-3f0f6c2d7a01' AND a."provider" = w."provider" AND w."provider_account_id" IS NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_provider_account_id_provider_payment_id_unique" UNIQUE("provider_account_id","provider_payment_id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_id_project_id_provider_account_id_unique" UNIQUE("id","project_id","provider_account_id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_id_project_id_unique" UNIQUE("id","project_id");--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_provider_account_id_provider_refund_id_unique" UNIQUE("provider_account_id","provider_refund_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_project_id_scope_key_unique" ON "idempotency_keys" USING btree ("project_id","scope","key");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_account_id_dedup_key_unique" ON "webhook_events" USING btree ("provider_account_id","dedup_key") WHERE "webhook_events"."replay_of" IS NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_provider_account_fk" FOREIGN KEY ("provider_account_id","project_id","provider") REFERENCES "public"."provider_accounts"("id","project_id","provider") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_project_account_fk" FOREIGN KEY ("payment_id","project_id","provider_account_id") REFERENCES "public"."payments"("id","project_id","provider_account_id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_payment_project_fk" FOREIGN KEY ("payment_id","project_id") REFERENCES "public"."payments"("id","project_id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_provider_account_id_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "public"."provider_accounts"("id") ON DELETE no action ON UPDATE no action NOT VALID;
