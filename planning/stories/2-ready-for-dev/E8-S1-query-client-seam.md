---
id: E8-S1-query-client-seam
epic: E8-QRY-query-client
status: ready-for-dev
area: query
touches: [query]
depends_on: []
api_impact: additive
---

# E8-S1-query-client-seam — Neutral query seam: `AnalyticsQueryClient` + `QueryResult`

## Why

Establishes the query read substrate: the neutral `AnalyticsQueryClient` interface (four business primitives + `rawQuery`) and the single neutral snapshot-shaped `QueryResult` every primitive and every adapter returns. No adapter yet — this is the type contract both the HTTP adapter (S3/S4) and the warehouse stub (S5) satisfy, and the thing that makes bar A provable.

## Scope

### In

- In `@analytics-kit/node`, a new module (e.g. `query/query-client.ts`) exporting the taxonomy-typed interface `AnalyticsQueryClient<TX extends TaxonomyShape>` with exactly five members:
  - `funnel(spec: FunnelSpec<TX>): Promise<QueryResult>`
  - `retention(spec: RetentionSpec<TX>): Promise<QueryResult>`
  - `trend(spec: TrendSpec<TX>): Promise<QueryResult>`
  - `uniqueCount(spec: UniqueCountSpec<TX>): Promise<QueryResult>`
  - `rawQuery(expr: string): Promise<QueryResult>`
- The four primitive **spec types**, taxonomy-typed so a funnel/trend over declared event names type-checks:
  - `FunnelSpec<TX>` — `{ steps: Array<keyof TX['events'] & string>; within: Duration; breakdown?: string }`
  - `RetentionSpec<TX>` — `{ cohortEvent: keyof TX['events'] & string; returnEvent: keyof TX['events'] & string; periods: number; granularity: Granularity; breakdown?: string }`
  - `TrendSpec<TX>` — `{ event: keyof TX['events'] & string; aggregation: Aggregation; window: Duration; breakdown?: string }`
  - `UniqueCountSpec<TX>` — `{ event: keyof TX['events'] & string; window: Duration; breakdown?: string }`
- The neutral supporting value types the specs reference: `Duration` (a neutral relative-window value — e.g. `{ value: number; unit: 'minute'|'hour'|'day'|'week'|'month' }` or a normalized string; pick the least-clever neutral form), `Granularity`, `Aggregation` (neutral enum unions — `'total'|'unique'|'dau'|...`; name by role, no vendor/HogQL vocabulary).
- The single neutral **result type**, placed in the **seam package** `analytics-kit` (not node — it is neutral and shared by every adapter), exported from its `index.ts`:
  - `interface QueryColumn { name: string; type?: string }`
  - `interface QueryResult { rows: ReadonlyArray<Record<string, unknown>>; columns: ReadonlyArray<QueryColumn>; generatedAt: string; fromCache?: boolean }`
- A compile-time `keyof` **pin test** for `AnalyticsQueryClient` in a node typing test (own pin — mirrors `NodeAnalytics`'s pin at `packages/node/src/typing.test.ts:104`), asserting `keyof AnalyticsQueryClient<never>` equals exactly the five members, and that each primitive returns `Promise<QueryResult>`.
- Export the interface + spec types + neutral value types from `@analytics-kit/node`'s `index.ts`; export `QueryResult`/`QueryColumn` from `analytics-kit`'s `index.ts`.

### Out

- Any adapter implementation (HTTP or warehouse) — S3/S4/S5.
- Config surface + no-op stub client — S2.
- Any wire mapping, HogQL, `kind`, or vendor result envelope — never on this surface; those live adapter-internal (S3+).
- Bespoke per-primitive result types (funnel steps object, retention matrix) — deliberately not built; one flat `QueryResult` serves all (see Technical notes).

## Acceptance criteria

- [ ] `AnalyticsQueryClient<TX>` exposes exactly `funnel`/`retention`/`trend`/`uniqueCount`/`rawQuery`, each returning `Promise<QueryResult>`; a `keyof` pin test enforces the member set (own pin — does not touch the frozen-15 `AnalyticsProvider` pin at `analytics-provider.test.ts:628`, nor the `NodeAnalytics` pin).
- [ ] `funnel({ steps })` / `trend({ event })` / `retention({ cohortEvent, returnEvent })` / `uniqueCount({ event })` type-check against declared taxonomy event names and reject an undeclared event name at compile time (a `@ts-expect-error` case in the typing test).
- [ ] No member signature, spec type, or value type names HogQL, `kind`, `$`-prefixed, `InsightVizNode`, or any vendor/query-dialect concept — business primitives only. `rawQuery` takes a plain `expr: string` (the string's dialect is the consumer's runtime responsibility; the type surface names no vendor).
- [ ] `QueryResult` lives in the `analytics-kit` seam package and is exported from its `index.ts`; `rows` values are typed `unknown` (adapter/engine-reported cells; a snapshot job casts at its own schema), `columns` is a distinct ordered array (an empty result still carries its schema).
- [ ] Bar A substrate: the interface is fully adapter-agnostic — nothing in it presumes an HTTP backend, so the S5 warehouse stub can satisfy it unchanged. Typecheck + lint + build green.

## Technical notes

- **Neutral surface speaks business primitives only.** HogQL / `kind` / vendor result types never appear on `funnel/retention/trend/uniqueCount`; `rawQuery(expr)` is the only place a dialect surfaces, and it surfaces as a *value* (the string), not a type. Exposing HogQL/`kind` on the interface was rejected — a warehouse adapter can't satisfy a HogQL-shaped interface (bar A). — architect (2026-07-07, epic Notes)
- **`rawQuery(expr: string): Promise<QueryResult>` — option (a), confirmed.** A `string` argument is a value, not a type, so it carries zero dialect info onto the interface; the signature names no vendor concept, exactly like a DB driver's `.query(sql)` or `fetch(url: string)`. The seam already votes for this pattern: `NeutralFetchOptions.body` / `fetch(url: string, ...)` in `packages/analytics-kit/src/adapter.ts` carries an adapter-specific wire payload as plain data behind a neutral string-typed signature — `rawQuery` is the same pattern one layer up. Rejected: generic `rawQuery<R>(...)` (invites an adapter-specific `R` to cross the boundary at the call site — reintroduces the leak, and compiles differently per adapter, breaking bar A's "same interface"); opaque branded wrapper (inert ceremony around a string). Pin: return `Promise<QueryResult>`, NOT `Promise<unknown>` — `rawQuery` is an escape hatch for the query *language* only, never for the result *contract*; a snapshot job persists rawQuery results through the identical path. — architect (2026-07-08)
- **Single flat `QueryResult` for all four primitives + rawQuery, confirmed.** posthog-js owns *no* funnel/retention/query result type (the SDK is a capture/flags/replay client; those shapes live server-side in the PostHog app), so a bespoke per-primitive result type would be *invented*, not a capability we'd lose by going flat — it is gold-plating pre-consumer. PostHog's own Query API returns funnel/retention/trend through *one* envelope; the primitive-specific structure is expressed as the **rows**, not a distinct top-level type. Retention survives flat as **tidy rows** — one row per `(cohort, period)` cell, e.g. `{ cohort: '2026-07-01', period: 3, count: 42, rate: 0.31 }` — which is already relational and exactly what a snapshot job INSERTs. A flat table only declines a pre-pivoted wide matrix, which is a presentation concern, not a snapshot concern (pivot downstream from tidy rows; un-pivoting a wide matrix is lossy). — architect (2026-07-08)
- **Three deliberate `QueryResult` calls** (architect 2026-07-08): (1) `rows` cell values are `unknown`, not a narrowed union — the cell type is adapter/engine-reported; a snapshot job casts at its own schema; over-narrowing would force adapters to lie. (2) `columns` is its own ordered typed array, not inferred from `rows[0]` keys — an empty result set must still carry its schema so a snapshot job can write a well-formed zero-row snapshot. (3) `fromCache?` is the ONLY normalized-away wire flag surfaced (from the wire `is_cached`); `generatedAt` (ISO-8601, adapter-set) covers the "when" a durable snapshot needs. Resist adding `last_refresh`/`timezone`/etc. cousins unless a snapshot consumer asks.
- **Own `keyof` pin discipline.** This is a SEPARATE surface — like `NodeAnalytics`, its pin is its own and must not reference `AnalyticsProvider`'s frozen-15 members. Follow the exact form at `packages/node/src/typing.test.ts:104-110` (`expectTypeOf<keyof AnalyticsQueryClient<never>>().toEqualTypeOf<...>()`).
- **Taxonomy typing.** Reuse the shipped `TaxonomyShape`/`ShapeOf` from `analytics-kit` (already imported by node). Event-name params are `keyof TX['events'] & string` (same idiom as `NodeCapture`'s `K extends keyof TX['events'] & string`). Under the default (untyped) shape, event names widen to `string` — the escape-hatch behavior E7 already establishes.
- **Value-type shapes (`Duration`/`Granularity`/`Aggregation`)** are the library's own neutral vocabulary — name by role. `breakdown?: string` is a property name the consumer supplies (a taxonomy prop key); leaving it a plain string is acceptable for R1 (tightening to `keyof props` is a future additive refinement, not R1 scope). Keep them minimal — the adapter maps them to the `[WIRE]` dialect (S3).

## Shipped
