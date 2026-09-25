import { Writable } from 'node:stream';
import { createLogger, type Logger } from './logger.ts';

/** A logger that captures parsed JSON lines, plus the raw text for leak assertions. */
export function captureLogger(): { logger: Logger; lines: () => Record<string, unknown>[]; raw: () => string } {
  let raw = '';
  const destination = new Writable({
    write(chunk: Buffer, _enc, done) {
      raw += chunk.toString();
      done();
    },
  });
  const logger = createLogger({ service: 'test', level: 'debug', destination });
  return {
    logger,
    raw: () => raw,
    lines: () =>
      raw
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}
