---
id: E8-S3-http-query-adapter-sync
epic: E8-QRY-query-client
status: ready-for-dev
area: query
touches: [adapters, node]
depends_on: [E8-S2-query-config-noop]
api_impact: additive
---

# E8-S3-http-query-adapter-sync — HTTP query adapter: sync path (primitive → wire → neutral result)

## Why

The first real query backend: maps each neutral primitive (and `rawQuery`) to the adapter-internal query wire, POSTs with Bearer personal-key auth, and normalizes the sync response envelope into the neutral `QueryResult`. This is what makes `createQueryClient` actually query, and — with S5's stub — proves bar A (two adapters, one interface).

## Scope

### In

- An HTTP query adapter module in `@analytics-kit/node` (e.g. `query/http-query-adapter.ts`), named **by role** (`HttpQueryAdapter` / `createHttpQueryAdapter` — never a vendor name), implementing `AnalyticsQueryClient<TX>`.
- Per-method translation (all adapter-internal `[WIRE]`, never surfaced):
  - `funnel` / `retention` / `trend` / `uniqueCount` → the matching kind-discriminated query body (`FunnelsQuery` / `RetentionQuery` / `TrendsQuery` / `HogQLQuery`-or-`TrendsQuery` for unique-count; insights often wrapped in `InsightVizNode.source`). The exact per-method body-field mapping needs a PostHog query-schema doc pull (see Technical notes / epic Development prerequisites).
  - `rawQuery(expr)` → a `HogQLQuery`-shaped body carrying the raw `expr` string through the same path.
- Transport: `POST {queryEndpoint}/... /query/` with headers `Authorization: Bearer <personalKey>` + `Content-Type: application/json`, using the injected `fetch` (`FetchLike`), project scope from `projectId`.
- **Normalize the sync envelope** `{ results, columns, types, hogql, is_cached, ... }` → neutral `QueryResult`: map `results` → `rows` (keyed by `columns`), `columns`/`types` → `QueryColumn[]`, `is_cached` → `fromCache`, set `generatedAt` (adapter wall-clock or normalized from the wire). The vendor envelope never escapes the adapter.
- Wire `createQueryClient`'s keyed+endpointed branch (the S2 fill-in) to construct this adapter.
- Unit tests against an **injected mock `fetch`** returning a canned sync envelope, asserting: correct URL/method/auth header, correct kind body per primitive, and correct envelope→`QueryResult` normalization. Never hits a real backend.

### Out

- Async refresh/poll (`{ query_status: { id, complete } }`) — S4. This story handles the SYNC envelope only.
- The warehouse stub — S5.
- Growing the neutral interface — anything the four primitives don't cover stays behind `rawQuery`.
- Live end-to-end validation against a real query endpoint — gated on a real personal key (a Development prerequisite, not a `blocked_by`); unit tests use a mock adapter.

## Acceptance criteria

- [ ] Each primitive POSTs to the config `queryEndpoint` with `Authorization: Bearer <personalKey>` and the correct kind-discriminated body; asserted via an injected mock `fetch` (no real network).
- [ ] The sync `{ results, columns, types, is_cached }` envelope is normalized to `QueryResult` (`rows` keyed by column name, `columns` ordered, `fromCache` from `is_cached`, `generatedAt` set) — the raw vendor envelope shape appears NOWHERE in the returned value or in any exported type.
- [ ] `rawQuery(expr)` delivers the raw string through the same POST path and returns the same normalized `QueryResult` — no separate result contract.
- [ ] No HogQL / `kind` / `$` / `InsightVizNode` / vendor identifier appears in any EXPORTED type or on the `AnalyticsQueryClient` surface — all wire vocabulary is confined to adapter-internal (non-exported) types.
- [ ] Bar A holds: this adapter and the S5 warehouse stub both satisfy `AnalyticsQueryClient<TX>` with zero interface change; swapping between them is zero consumer change. Typecheck + lint + test + build green.

## Technical notes

- **Adapter-internal wire [WIRE].** `POST {host}/api/projects/{projectId}/query/`, `Authorization: Bearer <personal_api_key>`; kind-discriminated body (`HogQLQuery` / `TrendsQuery` / `FunnelsQuery` / `RetentionQuery`, insights often wrapped in `InsightVizNode.source`); sync envelope `{ results, columns, types, hogql, is_cached, ... }`. All normalized to a neutral `QueryResult` before it reaches the consumer. — architect (2026-07-07, epic Notes)
- **Not a port — a from-scratch build.** posthog-js has NO query client (it is an ingestion/read-flags SDK only); this adapter is built against PostHog's HTTP Query API, which uses different auth + wire than ingestion. Do not look for a query client to copy in `posthog-js/packages/*` — there isn't one. — architect (2026-07-07, epic Notes)
- **Query-schema doc pull required.** The structured insight-query field schemas (Trends/Funnels/Retention `query` bodies) are NOT in the base reference; before writing the per-method body mapping, the builder should pull the PostHog query-schema doc (consult `posthog-source-guide` for how PostHog exposes the `/query/` endpoint + insight `kind` bodies, or fetch the schema doc). The exact per-method translation is med-confidence and firms up here. — epic Development prerequisites / architect (2026-07-07).
- **Neutral value types → wire.** Map the S1 neutral `Duration`/`Granularity`/`Aggregation` values to the wire's date-range/interval/math fields inside the adapter. The consumer never sees the wire field names.
- **`rawQuery` path.** `expr` is HogQL for THIS adapter (documented adapter-specific contract); wrap it in a `HogQLQuery` body. The warehouse adapter (S5) would treat the same `expr` as SQL — that dialect split is exactly why `rawQuery` takes a plain string and names no dialect (see S1 Technical notes).
- **Reuse the neutral `fetch` contract.** Read only `.status` + `.json()`/`.text()` off the response (same minimal surface as node capture's `NodeFetch` in `packages/node/src/send-batch.ts`). Inject `fetch` for testability exactly as E7 does.
- **Name by role.** `HttpQueryAdapter`, not any vendor name — the module is an internal adapter of the node package (BRIEF: adapters are internal modules named by role, never by vendor).

## Shipped
