import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from './logger.ts';

export interface ShutdownOptions {
  logger: Logger;
  /** Stops accepting work and waits for in-flight requests (e.g. `app.close()`). */
  close: () => Promise<void>;
  markShuttingDown: () => void;
  /** Run after `close`, in order: release pools, flush telemetry. */
  hooks?: (() => Promise<void>)[];
  drainDelayMs: number;
  timeoutMs: number;
  exit?: (code: number) => void;
}

/**
 * Returns an idempotent shutdown function: readiness goes false, wait `drainDelayMs`, close,
 * run hooks, exit 0. Any failure, or exceeding `timeoutMs`, exits 1.
 */
export function createShutdown(opts: ShutdownOptions): (signal: string) => Promise<void> {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let started: Promise<void> | undefined;

  return (signal) => {
    started ??= (async () => {
      opts.logger.info({ event: 'shutdown', signal }, 'shutting down');
      opts.markShuttingDown();
      const timer = setTimeout(() => {
        opts.logger.error({ event: 'shutdown_timeout' }, 'shutdown timed out');
        exit(1);
      }, opts.timeoutMs);
      timer.unref();
      let code = 0;
      try {
        await sleep(opts.drainDelayMs);
        await opts.close();
        for (const hook of opts.hooks ?? []) await hook();
      } catch (err) {
        opts.logger.error({ event: 'shutdown_failed', err }, 'shutdown failed');
        code = 1;
      }
      clearTimeout(timer);
      exit(code);
    })();
    return started;
  };
}

/** Wires SIGTERM and SIGINT to `createShutdown(opts)`. */
export function installShutdown(opts: ShutdownOptions): void {
  const shutdown = createShutdown(opts);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => void shutdown(signal));
  }
}
