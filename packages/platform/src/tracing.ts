import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { tracing } from '@opentelemetry/sdk-node';

export const REDACTED = '[REDACTED]';

/** Attributes that may carry a full URL (and therefore a query string) under old or new semconv. */
const URL_ATTRIBUTES = ['url.full', 'http.url', 'http.target'] as const;

/** Keeps the path and drops everything after `?`, which may hold tokens or personal data. */
export function stripQuery(value: string): string {
  const i = value.indexOf('?');
  return i < 0 ? value : `${value.slice(0, i)}?${REDACTED}`;
}

/**
 * Scrubs query strings from spans before any exporter sees them (principle 6). Runs in `onEnding`,
 * while the span is still mutable, so it must be registered before the exporting processor.
 * `onEnding` is marked experimental in the SDK; tracing.test.ts pins the behaviour we rely on.
 */
export class RedactingSpanProcessor implements tracing.SpanProcessor {
  onStart(): void {
    // Attributes are still being added at start; redaction happens in onEnding.
  }

  onEnding(span: tracing.Span): void {
    if (typeof span.attributes['url.query'] === 'string') span.setAttribute('url.query', REDACTED);
    for (const key of URL_ATTRIBUTES) {
      const value = span.attributes[key];
      if (typeof value === 'string' && value.includes('?')) span.setAttribute(key, stripQuery(value));
    }
  }

  onEnd(): void {
    // Nothing to do after the span is immutable.
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** Span processors for every PRYSM Node process: redact first, then batch-export via OTLP (OTEL_* env). */
export function traceSpanProcessors(exporter: tracing.SpanExporter = new OTLPTraceExporter()): tracing.SpanProcessor[] {
  return [new RedactingSpanProcessor(), new tracing.BatchSpanProcessor(exporter)];
}
