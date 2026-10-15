import { randomUUID } from 'node:crypto';
import type { Db } from './db.ts';

export interface ProvisionTenantInput {
  /** Lower-case slug, 3 to 63 characters of a-z, 0-9 and hyphen. */
  slug: string;
  name: string;
  /** The existing user who becomes the tenant's Owner. */
  ownerUserId: string;
}

/**
 * Creates a tenant with its settings and first Owner membership in one transaction, with no privileged role.
 *
 * The tenant id is generated here, from the OS CSPRNG, and can't be supplied by the caller. It then scopes
 * the transaction (`withTenant`), so `WITH CHECK` allows exactly that one id. The `tenants` row is inserted
 * first: if the id already existed the insert fails and the transaction aborts before any membership or
 * settings row is written, so signup can never write into an existing tenant (ADR-0013, G9).
 */
export async function provisionTenant(db: Db, input: ProvisionTenantInput): Promise<{ tenantId: string }> {
  if ('tenantId' in input) throw new TypeError('provisionTenant generates the tenant id; do not pass one');
  return provisionTenantWithId(db, randomUUID(), input);
}

/**
 * The same transaction with a caller-chosen id. Not exported from the package: it exists so tests can force
 * an id collision and prove the insert order. Production code must use `provisionTenant`.
 */
export async function provisionTenantWithId(
  db: Db,
  tenantId: string,
  { slug, name, ownerUserId }: ProvisionTenantInput,
): Promise<{ tenantId: string }> {
  await db.withTenant(tenantId, async (tx) => {
    await tx.query('INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)', [tenantId, slug, name]);
    await tx.query('INSERT INTO tenant_settings (tenant_id) VALUES ($1)', [tenantId]);
    await tx.query("INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')", [
      tenantId,
      ownerUserId,
    ]);
  });
  return { tenantId };
}
