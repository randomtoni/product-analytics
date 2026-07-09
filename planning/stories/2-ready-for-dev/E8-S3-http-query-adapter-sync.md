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
  - `funnel` / `retention` / `trend` / `uniqueCount` → the matching kind-discriminated query body (`FunnelsQuery` / `RetentionQuery` / `TrendsQuery` / `HogQLQuery`-or-`TrendsQuery` for unique-count). Send the inner query object DIRECTLY (`{ query: { kind: 'TrendsQuery', ... } }`) — do NOT wrap in `InsightVizNode.source`. The `InsightVizNode` wrapper is a PostHog *frontend presentation* container (its fields are all UI concerns: `showTable`/`showResults`/etc.); a headless query client POSTs the source query and the server runs it. (The epic Note's "insights often wrapped in `InsightVizNode.source`" describes how the PostHog UI *stores saved insights*, not what a query client must send — confirmed posthog-source-guide 2026-07-08.) The exact per-method body-field mapping needs a PostHog query-schema doc pull (see Technical notes / epic Development prerequisites).
  - `rawQuery(expr)` → a `HogQLQuery`-shaped body carrying the raw `expr` string through the same path.
- Transport: `POST {queryEndpoint}/api/projects/{projectId}/query/` (`queryEndpoint` is the config host; the `/api/projects/{projectId}/query/` path is adapter-internal — `projectId` is a PATH segment) with headers `Authorization: Bearer <personalKey>` + `Content-Type: application/json`, using the injected `fetch` (`FetchLike`).
- **Normalize the sync envelope** `{ results, columns, types, hogql, is_cached?, ... }` → neutral `QueryResult`: map `results` (plural) → `rows` (keyed by `columns`), `columns`/`types` → `QueryColumn[]`, `is_cached` → `fromCache` **read defensively** (`is_cached ?? false`, or leave `fromCache` unset when absent — see Technical notes: the wire flag is only present on cached responses), set `generatedAt` (adapter wall-clock or normalized from the wire). The vendor envelope never escapes the adapter.
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
- **Confirmed wire shapes (posthog-source-guide 2026-07-08, grounded in `PostHog/posthog:posthog/schema.py` @ HEAD).** Pins for the builder so the normalization is right the first time:
  - **`results` is plural + required**; `columns` / `types` are separate parallel optional arrays; `hogql` echoes the generated query. Base success response is `HogQLQueryResponse`.
  - **`is_cached` is conditionally present**: it lives ONLY on the `CachedHogQLQueryResponse` variant (returned when the query is cache-resolved), and is ABSENT on the uncached base response. Read it as `is_cached ?? false` — never assume it is there. This is why S1's `fromCache?` is optional.
  - **Path + auth**: `POST /api/projects/{projectId}/query/` with `projectId` as a **path segment** (not a body/query param), `Authorization: Bearer <personalKey>`. Resolve the full URL from `queryEndpoint` + the `/api/projects/{projectId}/query/` path (endpoint is the config-supplied host; the `/api/projects/.../query/` path is adapter-internal).
  - **Body**: raw HogQL is `{ query: { kind: 'HogQLQuery', query: '<expr>' } }`; Trends/Funnels/Retention are the source query sent directly under `{ query: { kind: '...', ... } }` — NOT wrapped in `InsightVizNode` (see Scope.In).
- **Not a port — a from-scratch build.** posthog-js has NO query client (it is an ingestion/read-flags SDK only); this adapter is built against PostHog's HTTP Query API, which uses different auth + wire than ingestion. Do not look for a query client to copy in `posthog-js/packages/*` — there isn't one. — architect (2026-07-07, epic Notes)
- **Query-schema doc pull required.** The structured insight-query field schemas (Trends/Funnels/Retention `query` bodies) are NOT in the base reference; before writing the per-method body mapping, the builder should pull the PostHog query-schema doc (consult `posthog-source-guide` for how PostHog exposes the `/query/` endpoint + insight `kind` bodies, or fetch the schema doc). The exact per-method translation is med-confidence and firms up here. — epic Development prerequisites / architect (2026-07-07).
- **Neutral value types → wire.** Map the S1 neutral `Duration`/`Granularity`/`Aggregation` values to the wire's date-range/interval/math fields inside the adapter. The consumer never sees the wire field names.
- **`rawQuery` path.** `expr` is HogQL for THIS adapter (documented adapter-specific contract); wrap it in a `HogQLQuery` body. The warehouse adapter (S5) would treat the same `expr` as SQL — that dialect split is exactly why `rawQuery` takes a plain string and names no dialect (see S1 Technical notes).
- **Use `FetchLike` (`typeof fetch`), NOT the narrow `NodeFetch`.** The query adapter must PARSE the response body (`.json()`), so it needs the fuller `FetchLike` contract already exported from `packages/node/src/config.ts` (it is `typeof fetch`, whose `Response` has `.json()`/`.text()`). Do NOT reuse capture's `NodeFetch` type (`send-batch.ts:16-19`) — that type intentionally declares ONLY `{ status: number }` because capture never reads a response body; it would not typecheck a `.json()` call. Read `.status` + `.json()` off the response. Inject `fetch` for testability exactly as E7 does (the E7 injected-`fetch` spy pattern is the mock-adapter precedent).
- **Name by role.** `HttpQueryAdapter`, not any vendor name — the module is an internal adapter of the node package (BRIEF: adapters are internal modules named by role, never by vendor).

## Shipped
