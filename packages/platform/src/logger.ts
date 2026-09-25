import { pino, type DestinationStream, type Logger } from 'pino';

/**
 * The only structured fields that may appear in logs. Anything else is dropped and only its key
 * name is kept, so prompts, responses and payloads can't leak through a stray `log.info({ body })`.
 * Add a field here only if it can never carry customer content.
 */
export const LOG_FIELDS: ReadonlySet<string> = new Set([
  'service',
  'tenant_id',
  'request_id',
  'trace_id',
  'span_id',
  'trace_flags',
  'event',
  'component',
  'method',
  'route',
  'status_code',
  'duration_ms',
  'check',
  'ok',
  'signal',
  'host',
  'port',
  'version',
  'err',
]);

/** Keeps allow-listed fields; replaces the rest with `dropped_fields: [names]`. */
export function allowlistFields(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (LOG_FIELDS.has(key)) out[key] = value;
    else dropped.push(key);
  }
  if (dropped.length > 0) out['dropped_fields'] = dropped;
  return out;
}

export interface LoggerOptions {
  service: string;
  level: string;
  destination?: DestinationStream;
}

/** JSON logger with ISO timestamps, the service name, and the field allowlist applied. */
export function createLogger({ service, level, destination }: LoggerOptions): Logger {
  return pino(
    {
      level,
      base: { service },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
        log: allowlistFields,
      },
    },
    destination,
  );
}

export type { Logger };
