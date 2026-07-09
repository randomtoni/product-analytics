---
id: E10-S7-kpi-snapshot-query-methods
epic: E10-CORE-example-consumer
status: ready-for-dev
area: core
touches: [example, query]
depends_on: [E10-S2-fernly-taxonomy-identity-mapping]
api_impact: additive
---

# E10-S7-kpi-snapshot-query-methods — KPI/snapshot definitions calling every query method

## Why

Exercises E8: Fernly's snapshot definitions call EVERY query primitive — `funnel`, `retention`, `trend`, `uniqueCount`, and the `rawQuery` escape hatch — each returning the snapshot-shaped result a persistence job expects. This proves the consumer owns snapshot storage + KPI definitions while the library owns the query primitives, config-only.

## Scope

### In

- A KPI/snapshot module (`examples/fernly/src/kpi/`) using `@analytics-kit/node` `createQueryClient(config)` → `AnalyticsQueryClient<TX>`, typed off the SAME Fernly taxonomy from S2.
- Snapshot definitions calling **each** method, event/step names taxonomy-typed:
  - `funnel({ steps: ['signup_started','signup_completed','document_uploaded'], within })` — activation
  - `retention({ cohortEvent, returnEvent, periods, granularity })` — cohort→return
  - `trend({ event, aggregation, window })` — engagement
  - `uniqueCount({ event, window })` — active reviewers
  - `rawQuery('<expr>')` — the escape hatch
- Each definition returns the neutral `QueryResult` shape a persistence job expects; a Fernly-side (consumer-owned) snapshot record wraps it. Snapshot STORAGE + KPI definitions live in the example, not the library.
- A runnable vitest test proving each method returns a well-formed `QueryResult` (rows/columns/generatedAt) against a mocked query response.

### Out

- The browser/react (S8) and node capture (S6) slices.
- Any real query endpoint / personal key — the query harness mocks transport (see Technical notes), never a real HogQL POST.
- Any `packages/*` edit.

## Acceptance criteria

- [ ] `createQueryClient(config)` is used (NEVER `createWarehouseQueryAdapter` or `createHttpQueryAdapter` imported directly) — proven in the code.
- [ ] All five methods (`funnel`/`retention`/`trend`/`uniqueCount`/`rawQuery`) are called with taxonomy-typed step/event names; a wrong event name is a compile error.
- [ ] Each returns a well-formed neutral `QueryResult` (`rows`/`columns`/`generatedAt`) — asserted against a mocked response.
- [ ] A Fernly-side snapshot record wraps each result — snapshot storage lives in the example, not the library.
- [ ] `turbo run typecheck` + `turbo run test` pass for `examples/fernly`.

## Technical notes

- **Use `createQueryClient`, never the adapter directly (E8 watch-item, locked).** — from E8 (2026-07-08): wire `createQueryClient(config)` — do NOT import `createWarehouseQueryAdapter` or `createHttpQueryAdapter` (proof/fill-in seats, not consumer paths). Do NOT select the warehouse adapter by config (not wired). `packages/node/src/query/create-query-client.ts`.
- **Query config is DISTINCT from ingest.** `QueryClientConfig`: `queryEndpoint`/`personalKey`/`projectId`/`taxonomy`/`fetch` (`packages/node/src/query/config.ts`). `personalKey` is a server read key — distinct from node's ingest `key`, server-side only, never in a browser bundle. Unkeyed (`personalKey` unset) ⇒ `QueryNoop` returning well-formed empty `QueryResult`s (bar B).
- **Method specs (taxonomy-typed).** `packages/node/src/query/query-client.ts` — `FunnelSpec.steps: Array<keyof TX['events'] & string>`, `RetentionSpec.cohortEvent/returnEvent`, `TrendSpec.event` + `aggregation: 'total'|'unique'|'dau'`, `UniqueCountSpec.event`, `rawQuery(expr: string)`. `Duration = { value, unit }`, `Granularity = 'day'|'week'|'month'`. All → `Promise<QueryResult>`.
- **`QueryResult` shape** (`packages/analytics-kit/src/query-result.ts`, exported from `analytics-kit`): `{ rows, columns, generatedAt, fromCache? }` — this IS the snapshot shape a persistence job stores.
- **Mock transport, not a real endpoint.** — architect (2026-07-08): to run against a mock with no backend, set `personalKey` + `queryEndpoint` + `projectId` and inject `config.fetch` returning canned wire responses so `HttpQueryAdapter` normalizes them into `QueryResult`. Never hit a real HogQL endpoint. (Or use the unkeyed `QueryNoop` and assert the empty-shape contract if a slice only needs the shape.)

## Shipped
