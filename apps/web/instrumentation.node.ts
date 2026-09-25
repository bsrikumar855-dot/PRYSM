import { traceSpanProcessors } from '@prysm/platform/tracing';
import { NodeSDK } from '@opentelemetry/sdk-node';

// Next.js creates spans for requests and route handlers itself. Query strings are redacted before export.
new NodeSDK({ spanProcessors: traceSpanProcessors() }).start();
