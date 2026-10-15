// The public surface of @prysm/db. There is deliberately no raw pool or client here (ADR-0003, ADR-0007):
// services receive a `Db` and reach tenant data only through `withTenant`.
export { createDb, type Db, type DbOptions, type TenantQueryResult, type TenantTx } from './db.ts';
