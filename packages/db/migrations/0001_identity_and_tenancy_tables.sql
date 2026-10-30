CREATE TABLE "memberships" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_pkey" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "memberships_tenant_user_key" UNIQUE("tenant_id","user_id"),
	CONSTRAINT "memberships_role_known" CHECK ("memberships"."role" IN ('owner', 'admin', 'compliance_manager', 'engineer', 'reviewer', 'auditor')),
	CONSTRAINT "memberships_status_known" CHECK ("memberships"."status" IN ('active', 'suspended'))
);
--> statement-breakpoint
CREATE TABLE "tenant_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"retention_mode" text DEFAULT 'metadata' NOT NULL,
	"retention_days" integer DEFAULT 365 NOT NULL,
	"sso_config_enc" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_settings_retention_mode_known" CHECK ("tenant_settings"."retention_mode" IN ('full', 'redacted', 'metadata')),
	CONSTRAINT "tenant_settings_retention_days_positive" CHECK ("tenant_settings"."retention_days" > 0)
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"region" text DEFAULT 'default' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_key" UNIQUE("slug"),
	CONSTRAINT "tenants_slug_format" CHECK ("tenants"."slug" ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'),
	CONSTRAINT "tenants_status_known" CHECK ("tenants"."status" IN ('active', 'suspended'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"password_algorithm" text,
	"password_memory_kib" integer,
	"password_passes" integer,
	"password_parallelism" integer,
	"password_salt" "bytea",
	"password_tag" "bytea",
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_key" UNIQUE("email"),
	CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email") AND length("users"."email") BETWEEN 3 AND 320),
	CONSTRAINT "users_password_all_or_none" CHECK (("users"."password_algorithm" IS NULL AND "users"."password_memory_kib" IS NULL AND "users"."password_passes" IS NULL
            AND "users"."password_parallelism" IS NULL AND "users"."password_salt" IS NULL AND "users"."password_tag" IS NULL)
        OR ("users"."password_algorithm" IS NOT NULL AND "users"."password_memory_kib" IS NOT NULL AND "users"."password_passes" IS NOT NULL
            AND "users"."password_parallelism" IS NOT NULL AND "users"."password_salt" IS NOT NULL AND "users"."password_tag" IS NOT NULL)),
	CONSTRAINT "users_failed_logins_nonnegative" CHECK ("users"."failed_logins" >= 0)
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;