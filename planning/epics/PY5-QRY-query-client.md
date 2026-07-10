---
id: PY5-QRY-query-client
status: planned
area: query
touches: [adapters]
api_impact: additive
blocked_by: [PY3-CORE-taxonomy-allowlist]
updated: 2026-07-09
---

# PY5-QRY-query-client — Python query client

## Why

The query client is the durable-KPI-snapshotting surface — the funnel/retention/trend/unique-count primitives plus a `raw_query` escape hatch, over a config-supplied HTTP query endpoint. It is the Python realization of TS `E8-QRY-query-client`, ported *to* `ts/packages/node/src/query/{query-client,http-query-adapter,warehouse-query-adapter}.ts`. It needs only the seam + taxonomy (PY2/PY3), so it runs in its own lane parallel to PY4. Informed by the architect consult (2026-07-09), Clusters 1 + 2.

## Success criteria

- `AnalyticsQueryClient` is a `Protocol` exposing `funnel(...)`, `retention(...)`, `trend(...)`, `unique_count(...)`, and `raw_query(expr)` (the adapter-specific escape hatch) — taxonomy-typed specs → a **flat `QueryResult`** the snapshot job expects (BRIEF §7).
- The HTTP query adapter speaks the config-supplied query endpoint with its own auth (a **server personal key**, distinct from the ingest key), performs the always-async poll as a **sync blocking poll** (the sync-client ruling — no asyncio), and **Pydantic-validates the wire response into `QueryResult`** (the one genuine inbound-wire boundary).
- A **warehouse-query-adapter typed stub** ships as the bar-A proof: two adapters, one `Protocol`, seam unchanged — a future SQL-over-a-consumer-warehouse adapter is fill-in-the-blanks.
- Unkeyed ⇒ a query **no-op** null object (bar B).
- The consumer owns snapshot STORAGE + KPI definitions; the library owns the query PRIMITIVES. Zero vendor references on the neutral surface — the wire query language, endpoint, and auth header are adapter-internal (`_WIRE_*` confined); the neutral spec/result name no vendor.

## Stories

_Tentative slice (story files not yet written):_

- **S1** — the `AnalyticsQueryClient` `Protocol` + the taxonomy-typed spec dataclasses (funnel/retention/trend/unique-count/raw) + the flat `QueryResult` shape + a config-selected factory (keyed ⇒ HTTP adapter, unkeyed ⇒ no-op).
- **S2** — the HTTP query adapter: config-supplied endpoint + personal-key Bearer auth, sync blocking poll, Pydantic wire-response → `QueryResult` decode, fetch-failure normalization at the boundary.
- **S3** — the warehouse-query-adapter typed stub (bar-A proof) + the query no-op (bar B).

## Out of scope

- Snapshot storage / scheduling / KPI definitions — the consumer's concern; the library ships the query primitives only.
- The ingest/capture surface (PY4) — a separate server surface with a separate key + endpoint.
- A live SQL-over-warehouse implementation — stubbed here; a future additive adapter.
- An async query client — the sync poll matches the sync-client ruling; async is an additive future.

## Notes

- **Ported to the TS query contract.** — architect (2026-07-09, Cluster 1): port *to* `query/query-client.ts` — same neutral primitives, flat result. The TS always-async HTTP poll (`http-query-adapter.ts`) becomes a **sync blocking poll** in Python (the sync-client ruling, Cluster 2), since the query client shares the port's sync posture.
- **Pydantic at the query-result boundary.** — architect (2026-07-09, Cluster 2, high): the HTTP query response is external untrusted JSON → Pydantic-validate into `QueryResult`. This is the one genuine inbound-wire boundary in the query path; the specs (library-built, outbound) stay plain dataclasses.
- **Two adapters, one Protocol = the bar-A proof.** The HTTP adapter + the warehouse stub prove provider-swap = one adapter, zero consumer change, seam unchanged — the same proof TS-E8 shipped (`warehouse-query-adapter.ts`).
- **Separate server config.** The query client's endpoint + personal key are distinct from the ingest key/endpoint (mirrors the TS `QueryClientConfig` vs ingest split) — Pydantic-validated config, adapter-internal auth header.
- **Wire vocabulary confined.** The query language over HTTP, the endpoint, and the auth header are `_WIRE_*` adapter-internal; the neutral `AnalyticsQueryClient` / spec / `QueryResult` surface names no vendor (the PY8 neutrality scan asserts this — recall the TS `HogQLQuery` vendor leak in `dist` that R1 review caught, HISTORY.md).

## Expansion path

A SQL-over-consumer-warehouse adapter (the stub's real implementation) or another vendor's query API is one new adapter satisfying the same `Protocol` — zero consumer change. An async query client is additive alongside the sync one.
