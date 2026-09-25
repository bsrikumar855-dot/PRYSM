import { tracing } from '@opentelemetry/sdk-node';
import { describe, expect, it } from 'vitest';
import { REDACTED, RedactingSpanProcessor, stripQuery, traceSpanProcessors } from './tracing.ts';

const CANARY = 'CANARY-token-abc123';

function tracerWith(exporter: tracing.InMemorySpanExporter) {
  const provider = new tracing.BasicTracerProvider({
    spanProcessors: [new RedactingSpanProcessor(), new tracing.SimpleSpanProcessor(exporter)],
  });
  return provider.getTracer('test');
}

describe('stripQuery', () => {
  it('keeps the path and replaces the query', () => {
    expect(stripQuery('/items/1?token=x')).toBe(`/items/1?${REDACTED}`);
    expect(stripQuery('https://api.example/v1/chat?key=x&y=1')).toBe(`https://api.example/v1/chat?${REDACTED}`);
    expect(stripQuery('/plain')).toBe('/plain');
  });
});

describe('RedactingSpanProcessor', () => {
  it('removes query strings from every URL attribute before export', () => {
    const exporter = new tracing.InMemorySpanExporter();
    const span = tracerWith(exporter).startSpan('GET', {
      attributes: { 'url.path': '/readyz', 'url.query': `token=${CANARY}` },
    });
    // Instrumentations also set attributes after start; those must be scrubbed too.
    span.setAttribute('url.full', `http://api:4000/readyz?token=${CANARY}`);
    span.setAttribute('http.target', `/readyz?token=${CANARY}`);
    span.setAttribute('http.url', `http://api:4000/readyz?token=${CANARY}`);
    span.end();

    const [exported] = exporter.getFinishedSpans();
    expect(JSON.stringify(exported?.attributes)).not.toContain(CANARY);
    expect(exported?.attributes).toMatchObject({
      'url.path': '/readyz',
      'url.query': REDACTED,
      'url.full': `http://api:4000/readyz?${REDACTED}`,
      'http.target': `/readyz?${REDACTED}`,
    });
  });

  it('leaves spans without query strings untouched', () => {
    const exporter = new tracing.InMemorySpanExporter();
    const span = tracerWith(exporter).startSpan('GET', { attributes: { 'url.full': 'http://api:4000/healthz' } });
    span.end();
    expect(exporter.getFinishedSpans()[0]?.attributes['url.full']).toBe('http://api:4000/healthz');
  });
});

describe('traceSpanProcessors', () => {
  it('puts redaction before export, so exporters only ever see scrubbed spans', async () => {
    const processors = traceSpanProcessors(new tracing.InMemorySpanExporter());
    expect(processors.map((p) => p.constructor.name)).toEqual(['RedactingSpanProcessor', 'BatchSpanProcessor']);
    await Promise.all(processors.map((p) => p.forceFlush()));
    await Promise.all(processors.map((p) => p.shutdown()));
  });
});
