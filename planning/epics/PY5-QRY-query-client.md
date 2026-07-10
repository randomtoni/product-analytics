---
id: PY5-QRY-query-client
status: active
area: query
touches: [adapters]
api_impact: additive
blocked_by: [PY3-CORE-taxonomy-allowlist]
updated: 2026-07-10
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

Chain — `S1 → {S2, S3}`; S2 and S3 both depend only on S1 (they can build in parallel, like TS E8's HTTP + warehouse tracks). Written to `stories/2-ready-for-dev/`. Fills the empty PY1-skeleton `query.py` (as a `query/` submodule). **Slice note:** the query **no-op** folds into S1 (co-located with the factory, mirroring TS `E8-S2`), NOT S3 — so S3 is the warehouse stub alone.

- **[PY5-S1](../stories/2-ready-for-dev/PY5-S1-query-protocol-specs-result-factory.md)** *(additive, no deps)* — `AnalyticsQueryClient` `Protocol` (5 sync members) + plain-`@dataclass` spec types (funnel/retention/trend/unique-count + `Duration`/`Granularity`/`Aggregation`) + Pydantic `QueryResult`/`QueryColumn` + separate Pydantic `QueryClientConfig` (distinct `personal_key`/`query_endpoint`) + `create_query_client` factory + `QueryNoop` (bar B).
- **[PY5-S2](../stories/2-ready-for-dev/PY5-S2-http-query-adapter.md)** *(additive, depends on S1)* — `HttpQueryAdapter`: Bearer-auth POST to the config endpoint, **sync-blocking-poll** (TS async poll → `time.sleep` loop, NO asyncio), Pydantic wire→`QueryResult` decode, fetch-failure normalization at the boundary, injectable transport on the ctor, all wire vocab `_WIRE_*`-confined (the highest-neutrality-risk surface — the `HogQLQuery`-leak class).
- **[PY5-S3](../stories/2-ready-for-dev/PY5-S3-warehouse-adapter-stub.md)** *(additive, depends on S1)* — `WarehouseQueryAdapter` typed not-implemented stub satisfying the Protocol unchanged (**the bar-A proof**: two adapters, one Protocol, zero consumer change) + documented per-method SQL mapping.

Build topo order: `PY5-S1 → PY5-S2` and `PY5-S1 → PY5-S3` (S2/S3 parallel).

**Module map** (a new `query/` submodule under `analytics_kit`, reading the PY2 seam + PY3 taxonomy; does NOT touch the PY4 server-capture path):

- `query/client.py` — `AnalyticsQueryClient` `Protocol` + spec dataclasses + `Duration`/`Granularity`/`Aggregation` + `QueryResult`/`QueryColumn` Pydantic models (S1)
- `query/config.py` — the separate `QueryClientConfig` Pydantic model (S1)
- `query/factory.py` — `create_query_client` (S1)
- `query/noop.py` — `QueryNoop` (S1)
- `query/http_adapter.py` — `HttpQueryAdapter` + the adapter-owned transport Protocol + `_WIRE_*` wire vocab (S2)
- `query/warehouse_adapter.py` — `WarehouseQueryAdapter` typed stub (S3)

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
