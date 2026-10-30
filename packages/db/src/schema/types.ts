import { customType } from 'drizzle-orm/pg-core';

/** Postgres `bytea` as a Node Buffer (salts, hashes). */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});
