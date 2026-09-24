// Loaded with `node --import @prysm/platform/otel` so instrumentation is in place before app code loads.
// Exporters, endpoint and service name come from the standard OTEL_* environment variables.
import { register } from 'node:module';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { NodeSDK } from '@opentelemetry/sdk-node';

register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

if (process.env['OTEL_SDK_DISABLED'] !== 'true') {
  const sdk = new NodeSDK({
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (req) => req.url === '/healthz',
        },
      }),
    ],
  });
  sdk.start();
  (globalThis as { __prysmOtel?: NodeSDK }).__prysmOtel = sdk;
}
