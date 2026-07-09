---
id: E8-S2-query-config-noop
epic: E8-QRY-query-client
status: ready-for-dev
area: query
touches: [node, query]
depends_on: [E8-S1-query-client-seam]
api_impact: additive
---

# E8-S2-query-config-noop — Query config + factory + unkeyed no-op query client

## Why

Gives the query client its own server-only config surface (endpoint + personal key + project scope, kept distinct from the ingest write key/host) and a config-selected factory that yields a silent no-op query client when unkeyed — so a consumer wiring by config alone gets bar B, and an unconfigured environment queries nothing. The factory + no-op are the seat the HTTP adapter (S3) and warehouse stub (S5) plug into.

## Scope

### In

- A `QueryClientConfig` type in `@analytics-kit/node` (e.g. `query/config.ts`):
  - `queryEndpoint?: string` — the config-supplied query host/URL (no vendor default).
  - `personalKey?: string` — the server personal/read key (Bearer auth), distinct from the ingest `key`.
  - `projectId?: string` — project scope for the query path.
  - `taxonomy?: Taxonomy<TaxonomyDecl>` — so specs type-check (same pattern as `NodeAnalyticsConfig`).
  - `fetch?: FetchLike` — consumer-injectable fetch (reuse the `FetchLike` type already exported from node's `config.ts`).
- A `createQueryClient` factory (overloaded like `createAnalytics`: a taxonomy-bearing overload returning `AnalyticsQueryClient<ShapeOf<T>>` and a bare overload returning `AnalyticsQueryClient<DefaultTaxonomyShape>`):
  - **Unkeyed ⇒ silent no-op.** When `personalKey` is absent, return a `QueryNoop` null-object client (see below). No network, no adapter constructed.
  - When keyed but `queryEndpoint` absent, emit a one-line `console.warn` (mirrors `createAnalytics`'s host-less warning) and still return a no-op (a query with no endpoint has nowhere to go).
  - When keyed + endpointed, return the real client wired to the HTTP adapter — **wired in S3**; in THIS story the keyed branch may return the no-op / a placeholder that S3 replaces (do not build the HTTP adapter here). Keep the branch structured so S3 is a fill-in, not a reshape.
- A `QueryNoop<TX>` null object implementing `AnalyticsQueryClient<TX>` — every method resolves to a **neutral empty `QueryResult`** (`{ rows: [], columns: [], generatedAt: <now ISO> }`), never throws, never touches the network. Mirrors the `NodeNoop` pattern (`packages/node/src/node-noop.ts`).
- Export `createQueryClient` + `QueryClientConfig` from `@analytics-kit/node`'s `index.ts`.

### Out

- The HTTP query adapter (sync mapping/POST) — S3.
- Async refresh/poll — S4.
- The warehouse stub — S5.
- Any real network call — the no-op is the only client that runs in this story.

## Acceptance criteria

- [ ] `createQueryClient({})` (no `personalKey`) returns a client whose every method resolves to an empty `QueryResult` and makes zero network calls — proven by a test with an injected `fetch` spy asserting zero invocations (bar B: unkeyed ⇒ queries nothing).
- [ ] `personalKey` / `queryEndpoint` / `projectId` are a **distinct** config surface from the ingest `key` / `ingestHost` — a query config carrying only a `personalKey` does not accidentally read the ingest write key, and vice-versa (server-only; the personal key never appears in any browser-package config).
- [ ] Keyed-but-endpointless emits exactly one `console.warn` and returns a safe no-op (never a client that POSTs to a host-less URL).
- [ ] The taxonomy overload returns `AnalyticsQueryClient<ShapeOf<T>>` so specs type-check off the consumer's taxonomy; the bare overload widens to `DefaultTaxonomyShape`. `keyof` pin from S1 still holds.
- [ ] `QueryNoop` implements `AnalyticsQueryClient<TX>` structurally (implements-clause compiles). Typecheck + lint + test + build green.

## Technical notes

- **Auth/config is a distinct, server-only surface.** Query uses a **server personal key** with a config-supplied endpoint + project scope, kept separate from the ingest write key/host (E5/E7). Personal-key handling is server-side only — never shipped to the browser, keys never in client code. Reusing the ingest write key for queries was rejected (wrong scope, unsafe). — architect (2026-07-07, epic Notes)
- **Unkeyed ⇒ silent no-op/stub.** Endpoint, project scope, and personal key are all consumer-supplied; the client is server-side only — never in the browser bundle. — epic Success criteria.
- **Factory + null-object pattern.** Mirror `createAnalytics` (`packages/node/src/create-analytics.ts`) and `NodeNoop` (`packages/node/src/node-noop.ts`) exactly: overloaded factory, `personalKey === undefined ⇒ new QueryNoop()`, structured keyed branch. The no-op implements the narrow `AnalyticsQueryClient` (shape A standalone client), NOT the seam's wider `AnalyticsAdapter` — same reasoning as `NodeNoop`.
- **No-op returns an empty `QueryResult`, not a throw or `undefined`.** A snapshot job calling a no-op client in an unkeyed env should get a well-formed zero-row snapshot (columns `[]`, rows `[]`, `generatedAt` set), not an exception — matches the "no-op when unkeyed" posture (a disabled analytics env produces empty data, not errors).
- **Reuse `FetchLike`** already exported from `packages/node/src/config.ts` (`typeof fetch`) — the query adapter (S3) reads only `.status`/`.json()`/`.text()` off the response, same minimal contract as node capture's `NodeFetch`.
- **Keyed branch is deliberately a fill-in for S3.** Do not build the HTTP adapter here; leave the keyed path returning the no-op (or a clearly-marked placeholder) so S3 slots the real adapter in without reshaping the factory. — PM (sequencing).

## Shipped
