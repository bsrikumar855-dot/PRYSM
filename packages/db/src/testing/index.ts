// Test harness for integration suites. Needs the dev/CI stack and DATABASE_URL_TEST_ADMIN; never imported by services.
export { findRlsGaps, type RlsGap } from '../rls-coverage.ts';
export { createTestDatabase, suiteScope, sweepStaleTestDatabases, type TestDatabase } from './harness.ts';
export { TEMPLATE_DATABASE, TEST_DATABASE_PREFIX } from './urls.ts';
