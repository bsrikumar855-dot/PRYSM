import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { bytea } from './types.ts';

/**
 * Global identity table (ADR-0013): one row per person, shared by every tenant they belong to, so it
 * carries no tenant_id and no RLS. It holds identity only, never tenant data. The password is stored as
 * columns, not a PHC string (ADR-0012): algorithm, parameters, salt and tag. Emails are stored lower-case.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    passwordAlgorithm: text('password_algorithm'),
    passwordMemoryKib: integer('password_memory_kib'),
    passwordPasses: integer('password_passes'),
    passwordParallelism: integer('password_parallelism'),
    passwordSalt: bytea('password_salt'),
    passwordTag: bytea('password_tag'),
    failedLogins: integer('failed_logins').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('users_email_key').on(t.email),
    check('users_email_lowercase', sql`${t.email} = lower(${t.email}) AND length(${t.email}) BETWEEN 3 AND 320`),
    check(
      'users_password_all_or_none',
      sql`(${t.passwordAlgorithm} IS NULL AND ${t.passwordMemoryKib} IS NULL AND ${t.passwordPasses} IS NULL
            AND ${t.passwordParallelism} IS NULL AND ${t.passwordSalt} IS NULL AND ${t.passwordTag} IS NULL)
        OR (${t.passwordAlgorithm} IS NOT NULL AND ${t.passwordMemoryKib} IS NOT NULL AND ${t.passwordPasses} IS NOT NULL
            AND ${t.passwordParallelism} IS NOT NULL AND ${t.passwordSalt} IS NOT NULL AND ${t.passwordTag} IS NOT NULL)`,
    ),
    check('users_failed_logins_nonnegative', sql`${t.failedLogins} >= 0`),
  ],
);
