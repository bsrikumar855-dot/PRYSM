/** Next.js hook: start OpenTelemetry in the Node.js runtime (exporters come from OTEL_* env vars). */
export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] === 'nodejs' && process.env['OTEL_SDK_DISABLED'] !== 'true') {
    await import('./instrumentation.node');
  }
}
