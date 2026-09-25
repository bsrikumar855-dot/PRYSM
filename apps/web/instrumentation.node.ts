import { NodeSDK } from '@opentelemetry/sdk-node';

// Next.js creates spans for requests and route handlers itself; the SDK only needs to export them.
new NodeSDK().start();
