---
id: E8-QRY-query-client
status: planned
area: query
touches: [node, adapters]
api_impact: additive
blocked_by: [E2-CORE-provider-seam]
updated: 2026-07-07
---

# E8-QRY-query-client — Query client: interface + HTTP query adapter + warehouse stub

## Why

Durable KPI snapshotting needs a neutral read surface: a snapshot job asks for a funnel / retention / trend / unique-count and persists the result on the consumer's own schedule. The consumer owns snapshot STORAGE + KPI definitions; the library owns the query PRIMITIVES. This is the whole `query` area — it runs in its own lane once the core seam exists, independent of the identify/capture/react and node tracks (`research/ARCHITECT-RELEASE1.md` §E8).

## Success criteria

- `AnalyticsQueryClient` (in `@analytics-kit/node`) exposes `funnel({steps, within, breakdown?})` · `retention({cohortEvent, returnEvent, periods, granularity, breakdown?})` · `trend({event, aggregation, breakdown?, window})` · `uniqueCount({event, window, breakdown?})` · `rawQuery(expr)`. Signatures carry **business primitives only** — no HogQL, no `kind`, no vendor types; `rawQuery(expr)` is the sole adapter-specific passthrough and is typed as such.
- Each structured method returns a neutral, **snapshot-shaped** result (rows + metadata) a snapshot job can persist directly — the raw HogQL/Query-API envelope (`results/columns/types/is_cached`) is normalized away inside the adapter.
- The HTTP query adapter translates each method into the matching Query-API `kind` and POSTs to the config-supplied endpoint with Bearer personal-key auth; both the sync envelope and the async refresh/poll path are handled **adapter-internally** and never surface on the interface.
- The warehouse adapter is an **interface-satisfying stub** that is this release's **bar-A proof** — a second backend that typechecks against `AnalyticsQueryClient` unchanged (swapping to it is zero consumer change), with the intended per-method SQL mapping documented so filling it in later is fill-in-the-blanks.
- **Unkeyed ⇒ silent no-op/stub.** Query endpoint, project scope, and server personal key are all consumer-supplied; the client is **server-side only** — never shipped to the browser bundle, keys never in client code.
- **Bar A:** swapping the HTTP adapter for the warehouse stub (or a mock) is zero consumer change — the four primitives satisfy the same neutral interface. **Bar B:** a new consumer wires funnel/retention/trend/uniqueCount by config only, zero library change.

## Development prerequisites

- A live Query-API endpoint + a **server personal API key** (Query Read scope) to validate the HTTP adapter end-to-end. The neutral interface, the adapter code, and the warehouse stub all build and unit-test against a mock/in-memory adapter without this; the key gates **live validation only**, so it is not a `blocked_by` gate on building.
- The structured insight-query field schemas (Trends/Funnels/Retention `query` bodies) are not in the two cited doc pages; the HTTP adapter story will need a PostHog query-schema doc pull when it is built.

## Stories

Tentative slice — story files not yet written.

- **S1 — neutral query seam.** `AnalyticsQueryClient` interface + the neutral snapshot-shaped result types (rows + metadata), business primitives only, `rawQuery(expr)` typed as an adapter-specific passthrough. Establishes the query substrate; no adapter yet.
- **S2 — query config + no-op stub.** `query: { endpoint, apiKey, projectId? }` config, server-only personal-key handling (kept distinct from the ingest key/host), and a silent stub client when unkeyed.
- **S3 — HTTP adapter, sync path.** Map funnel/retention/trend/uniqueCount → kind-discriminated body (`HogQLQuery`/`TrendsQuery`/`FunnelsQuery`/`RetentionQuery`), POST with Bearer auth, normalize the sync `{results, columns, types, is_cached}` envelope → neutral result; `rawQuery(expr)` delivers HogQL through the same path.
- **S4 — HTTP adapter, async execution.** Refresh/poll the async `{query_status: { id, complete }}` envelope for long-running queries, still returning the same neutral result shape.
- **S5 — warehouse adapter stub.** Interface-satisfying typed stub with the intended per-method SQL mapping documented (fill-in-the-blanks for a future SQL-over-consumer-warehouse adapter).

## Out of scope

- KPI definitions, snapshot storage, and snapshot scheduling — consumer territory. The library owns query primitives; the consumer owns the snapshot job and where results land.
- The warehouse adapter's actual SQL implementation — this release ships the stub only; filling it in is a future additive adapter.
- Dashboards, charts, or any query-result visualization — UI/consumer territory, not `query`.
- Broader HogQL / insight-query surface beyond the four business primitives — anything else stays behind `rawQuery(expr)`; we do not grow the neutral interface to cover more of the vendor dialect.

## Notes

- **Not a port — a from-scratch build.** posthog-js has **no** query client (it is an ingestion/read-flags SDK only); E8 is designed and built against PostHog's HTTP Query API, which uses a different auth and wire than ingestion. — architect (2026-07-07): §E8, cross-cutting gap #2.
- **Neutral surface speaks business primitives only.** HogQL, `kind`, and vendor result types never appear in `funnel/retention/trend/uniqueCount` signatures; `rawQuery(expr)` is the only place a vendor dialect surfaces and must be typed as an adapter-specific passthrough. Exposing HogQL/`kind` on the interface was rejected — a warehouse adapter can't satisfy a HogQL-shaped interface (bar A). — architect (2026-07-07)
- **Adapter-internal wire [WIRE].** `POST {host}/api/projects/{projectId}/query/`, `Authorization: Bearer <personal_api_key>`; kind-discriminated body (`HogQLQuery`/`TrendsQuery`/`FunnelsQuery`/`RetentionQuery`, insights often wrapped in `InsightVizNode.source`); sync envelope `{results, columns, types, hogql, is_cached, ...}`; async mode returns `{query_status: { id, complete }}` to poll. All normalized to a neutral snapshot-shaped result before it reaches the consumer. — architect (2026-07-07)
- **Auth/config is a distinct, server-only surface.** Query uses a **server personal key** with a config-supplied endpoint + project scope, kept separate from the ingest write key/host (E5). Personal-key handling is server-side only — never shipped to the browser, keys never in client code. Reusing the ingest write key for queries was rejected (wrong scope, unsafe). — architect (2026-07-07)
- **Warehouse target is a stub only** — define the interface + a typed `NotImplemented`-style stub so the shape is proven and "a new adapter is fill-in-the-blanks" (BRIEF deliverable 4). — architect (2026-07-07)
- **Independence.** E8 needs only the core cycle (the `E2` provider seam) — it does not depend on the identify/capture/browser tracks or on E7 node capture. Runs in its own `{query}` lane per ROADMAP. Confidence on the neutral interface shape is high; the exact per-method HogQL translation is med-confidence and firms up when the adapter is built against a query-schema doc pull. — architect (2026-07-07)

## Expansion path

The future SQL-over-consumer-warehouse adapter fills in the S5 stub — additive, one new adapter, zero interface change (bar A). A second vendor's query API is likewise one new adapter behind the same `AnalyticsQueryClient`. `rawQuery(expr)` remains the only dialect-specific surface, so growth stays additive and off the neutral primitives.
