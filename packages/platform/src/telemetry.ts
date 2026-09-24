/** Flushes and stops the OpenTelemetry SDK started by `@prysm/platform/otel`, if any. */
export async function shutdownTelemetry(): Promise<void> {
  const sdk = (globalThis as { __prysmOtel?: { shutdown: () => Promise<void> } }).__prysmOtel;
  await sdk?.shutdown();
}
