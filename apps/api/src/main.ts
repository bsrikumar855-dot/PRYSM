import { createDb } from '@prysm/db';
import { createLogger, installShutdown, loadConfig, shutdownTelemetry } from '@prysm/platform';
import { Redis } from 'ioredis';
import { apiEnv, buildApi } from './app.ts';

const config = loadConfig(apiEnv);
const logger = createLogger({ service: config.SERVICE_NAME, level: config.LOG_LEVEL });
const db = createDb({ connectionString: config.DATABASE_URL_APP, applicationName: 'prysm-api' });
// No offline queue: while Valkey is unreachable, commands fail fast and /readyz reports it.
const valkey = new Redis(config.VALKEY_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
valkey.on('error', (err: Error) => {
  logger.warn({ event: 'valkey_error', err }, 'valkey connection error');
});

const { app, markShuttingDown } = buildApi({ logger, db, valkey });

installShutdown({
  logger,
  markShuttingDown,
  close: () => app.close(),
  hooks: [() => db.end(), () => valkey.quit().then(() => undefined), shutdownTelemetry],
  drainDelayMs: config.SHUTDOWN_DRAIN_DELAY_MS,
  timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
});

await app.listen({ host: config.HOST, port: config.PORT });
logger.info({ event: 'started', port: config.PORT }, 'api listening');
