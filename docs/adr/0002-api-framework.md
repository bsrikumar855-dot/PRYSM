# ADR-0002: API framework and contract

Status: Accepted · 2026-09-24

## Context

`api` serves the public REST API (OpenAPI 3.1, versioned), the console, webhooks, and log ingestion. `gateway` needs the lowest-overhead HTTP stack we can get. The brief asks for "OpenAPI-first".

## Decision

- **Fastify** for both `api` and `gateway`. One framework, one plugin model, and one way to handle auth, errors and OTel.
- **Contract source of truth: zod schemas in `packages/core-types`**, wired to routes via `fastify-type-provider-zod`. The OpenAPI 3.1 document is **generated** from the route schemas and committed to `docs/api/openapi.json`. CI regenerates it and fails on any diff. `oasdiff` flags breaking changes against `main`, and a breaking change requires a new `/v2` path or an explicit ADR.
- URL versioning (`/v1`). Errors use RFC 9457 `application/problem+json`. Cursor pagination. Mutating endpoints accept `Idempotency-Key`.
- Customer SDK types (`sdk-js`, `sdks/python`) are generated from the committed spec.

## Deviation from brief

This is "schema-first", not hand-written "OpenAPI-first". A hand-written YAML spec and its TS types drift apart. With zod as the single source, runtime validation, static types and the spec can't disagree, and the committed spec is still the reviewed, diffable contract. **Approved by owner 2026-09-24.**

## Consequences

- The spec's quality depends on how disciplined we are with zod `.describe()` and examples. The CI lint (Spectral) requires descriptions on every operation and schema.
- Route handlers stay thin. Domain logic lives in plain modules so it can be tested without HTTP.

## Alternatives

- **NestJS:** DI and decorators add weight and indirection. It would be a different framework from the gateway, and slower per request. Its main win, structure for large teams, is covered by conventions.
- **Hand-written OpenAPI + codegen (openapi-typescript):** viable, but it keeps two sources that can disagree.
- **tRPC:** great for web ↔ api, but not a public REST contract.
