import { describe, expect, it, vi } from 'vitest';
import { createShutdown } from './shutdown.ts';
import { captureLogger } from './test-helpers.ts';

function setup(overrides: { close?: () => Promise<void>; timeoutMs?: number } = {}) {
  const calls: string[] = [];
  const exit = vi.fn((code: number) => calls.push(`exit:${String(code)}`));
  const shutdown = createShutdown({
    logger: captureLogger().logger,
    markShuttingDown: () => calls.push('not-ready'),
    close:
      overrides.close ??
      (() => {
        calls.push('close');
        return Promise.resolve();
      }),
    hooks: [
      () => {
        calls.push('hook1');
        return Promise.resolve();
      },
      () => {
        calls.push('hook2');
        return Promise.resolve();
      },
    ],
    drainDelayMs: 0,
    timeoutMs: overrides.timeoutMs ?? 1_000,
    exit,
  });
  return { calls, exit, shutdown };
}

describe('createShutdown', () => {
  it('marks not-ready, closes, runs hooks in order, exits 0', async () => {
    const { calls, shutdown } = setup();
    await shutdown('SIGTERM');
    expect(calls).toEqual(['not-ready', 'close', 'hook1', 'hook2', 'exit:0']);
  });

  it('is idempotent across repeated signals', async () => {
    const { exit, shutdown } = setup();
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('exits 1 when closing fails', async () => {
    const { calls, shutdown } = setup({ close: () => Promise.reject(new Error('boom')) });
    await shutdown('SIGTERM');
    expect(calls).toEqual(['not-ready', 'exit:1']);
  });

  it('exits 1 when shutdown exceeds the timeout', async () => {
    vi.useFakeTimers();
    const { exit, shutdown } = setup({ close: () => new Promise(() => undefined), timeoutMs: 100 });
    void shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(150);
    expect(exit).toHaveBeenCalledWith(1);
    vi.useRealTimers();
  });
});
