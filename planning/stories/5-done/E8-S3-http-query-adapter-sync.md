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
- > Reviewer suggestion (2026-07-08, improvement-pass candidate): `run()` reads `response.json()` unconditionally without checking `.status` — a 401/403 (bad personal key) or 400 (malformed query) parses an error body → raw JSON-parse throw or a garbage `QueryResult`. The story's Technical notes pinned "Read `.status` + `.json()`". Add a minimal `if (!response.ok) throw <neutral error>` guard so vendor error shapes don't leak (also the S4/error-handling seam).
- > Reviewer suggestion (2026-07-08): `createHttpQueryAdapterFromConfig` spreads the full `config` into `HttpQueryAdapterOptions` (carries `taxonomy`/etc. the adapter doesn't declare) — pass the four fields (`queryEndpoint`/`personalKey`/`projectId`/`fetch`) explicitly so the adapter's input surface is exactly what it consumes.
- > Reviewer suggestion (2026-07-08): `projectId ?? ''` → a projectless keyed+endpointed config builds a malformed `.../api/projects//query/` URL that fails opaquely server-side — warn (like the endpointless branch) or document `projectId` required on this path.

## Shipped

> Captured by `implement-epics` on 2026-07-08. The first real query backend — bar-A proof (with S5's stub).

- **Files added (node/query):** `http-query-adapter.ts` (role-named `HttpQueryAdapter`/`createHttpQueryAdapter` implements `AnalyticsQueryClient<TX>`; per-method neutral→`[WIRE]` kind bodies sent DIRECTLY `{query:{kind:...}}` — NOT `InsightVizNode`-wrapped; table-driven neutral-value→wire mapping `INTERVAL_FOR_UNIT`/`MATH_FOR_AGGREGATION`/`RETENTION_PERIOD_FOR_GRANULARITY`/`relativeDateFrom`; Bearer-auth POST `{host}/api/projects/{projectId}/query/` via injected `FetchLike`; exported-module-internal `normalizeResult` envelope→`QueryResult`) + test
- **Files changed:** `create-query-client.ts` (keyed+endpointed branch constructs the REAL adapter — S2 fill-in replaced), `index.ts` (exports role-named `HttpQueryAdapter`/`createHttpQueryAdapter`/`HttpQueryAdapterOptions`; `normalizeResult`+all `Wire*` types stay module-internal, off the public surface)
- **New public API:** `@analytics-kit/node` `HttpQueryAdapter`/`createHttpQueryAdapter` (+options). ALL wire vocab (`kind` bodies, casing, `is_cached`, envelope) adapter-internal — `.d.ts` grep clean of `hogql|insightviz|posthog|$|kind|is_cached|dateRange`.
- **Wire grounding (posthog-source-guide, `posthog/schema`):** inner query sent directly (no InsightVizNode); camelCase nodes / snake_case leaves / CAPITALIZED `RetentionPeriod` vs lowercase `IntervalType`; `results` plural+required, `columns`/`types` parallel optional, `is_cached` ONLY on cached variant.
- **Normalization:** `results`→`rows` keyed by `columns`; `columns`/`types`→`QueryColumn[]` ordered; `is_cached`→`fromCache` set ONLY when present (true/false/undefined preserved, NOT coerced); `generatedAt` set. Vendor envelope NOWHERE in the result (test: `Object.keys(result).sort()` === exactly `columns/fromCache/generatedAt/rows`).
- **Tests added:** node +24 (22 adapter: per-primitive POST+Bearer+kind-body-direct-not-wrapped, Duration/Aggregation/Granularity→wire, rawQuery HogQL same-path, envelope→QueryResult is_cached present-true/false/absent, columns-ordered, vendor-envelope-nowhere, trailing-slash, no-vendor-host; +2 factory real-adapter-wired) → 159; seam 172 unchanged
- **Commit:** `E8-S3-http-query-adapter-sync — HTTP query adapter: sync path (primitive → wire → neutral result)` on `core-cycle`
- **Reviewer notes:** 0 critical, 3 suggestions (non-OK guard improvement-pass candidate; explicit-fields; projectId-empty warn)
- **Cross-story seams exposed:** **S4** extends `WireSyncEnvelope` with the `{query_status:{id,complete}}` variant + a bounded poll loop inside `run()`; reuses `normalizeResult(source: WireResultBearing, fromCache)` VERBATIM on `query_status.results` (columns absent there → pass-through branch; `fromCache` threaded as a separate arg precisely because async lives at a different level). Also the non-OK guard hooks here. **S5** parallel role-named class `implements AnalyticsQueryClient<TX>` — bar-A assignability already demonstrated (`HttpQueryAdapter`/`QueryNoop`/warehouse all swap zero-consumer-change).

## Follow-up

> E8 post-close improvement pass, 2026-07-08 (commit follows). Reviewer-verified, no regression (node 180 / seam 172 green, typecheck exit 0).

- **Explicit 4-field construction** — `createHttpQueryAdapterFromConfig` no longer spreads the full `config`; it takes/passes EXACTLY `queryEndpoint`/`personalKey`/`projectId`/`fetch` (input type tightened, dropped the unused `QueryClientConfig` import). Behavior-preserving. (Addresses the S3 spread suggestion.)
- **projectId-empty warning** — a construction-time `console.warn` (once, neutral, no-throw) fires on the keyed+endpointed branch when `projectId` is absent/empty (the `.../api/projects//query/` malformed-URL misconfig) — mirrors the endpointless warn; still returns the real adapter. Tests: warns for no/empty projectId, not when present. (Addresses the S3 projectId suggestion.)
- Skipped-with-reason: the S3 non-OK response guard was already added to `run()` in S4 (POST + poll, `response.ok === false` neutral throw).
