import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './identity.ts';

/**
 * The tenant itself (ADR-0013). It has no tenant_id column: its RLS policy is on `id`, so a tenant
 * sees only its own row. Every other tenant table points here with a `tenant_id`.
 */
export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    region: text('region').notNull().default('default'),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('tenants_slug_key').on(t.slug),
    check('tenants_slug_format', sql`${t.slug} ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'`),
    check('tenants_status_known', sql`${t.status} IN ('active', 'suspended')`),
  ],
);

/** Per-tenant settings (I-09). One row per tenant; `tenant_id` is the key. */
export const tenantSettings = pgTable(
  'tenant_settings',
  {
    tenantId: uuid('tenant_id').primaryKey(),
    retentionMode: text('retention_mode').notNull().default('metadata'),
    retentionDays: integer('retention_days').notNull().default(365),
    ssoConfigEnc: text('sso_config_enc'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'tenant_settings_tenant_fk', columns: [t.tenantId], foreignColumns: [tenants.id] }),
    check('tenant_settings_retention_mode_known', sql`${t.retentionMode} IN ('full', 'redacted', 'metadata')`),
    check('tenant_settings_retention_days_positive', sql`${t.retentionDays} > 0`),
  ],
);

/**
 * A user's membership of a tenant, with a role. Keyed `(tenant_id, id)` so other tenant tables can
 * reference it with a composite foreign key that cannot cross tenants. `user_id` points at the global
 * `users` table with a plain foreign key.
 */
export const memberships = pgTable(
  'memberships',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id').notNull().defaultRandom(),
    userId: uuid('user_id').notNull(),
    role: text('role').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'memberships_pkey', columns: [t.tenantId, t.id] }),
    foreignKey({ name: 'memberships_tenant_fk', columns: [t.tenantId], foreignColumns: [tenants.id] }),
    foreignKey({ name: 'memberships_user_fk', columns: [t.userId], foreignColumns: [users.id] }),
    unique('memberships_tenant_user_key').on(t.tenantId, t.userId),
    check(
      'memberships_role_known',
      sql`${t.role} IN ('owner', 'admin', 'compliance_manager', 'engineer', 'reviewer', 'auditor')`,
    ),
    check('memberships_status_known', sql`${t.status} IN ('active', 'suspended')`),
  ],
);
