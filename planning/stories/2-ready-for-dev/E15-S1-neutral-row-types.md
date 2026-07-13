---
id: E15-S1-neutral-row-types
epic: E15-QRY-response-row-contract
status: ready-for-dev
area: query
touches: [node]
depends_on: []
api_impact: breaking
---

# E15-S1-neutral-row-types — Neutral per-primitive row types + generic QueryResult envelope

## Why

The read side has no row contract — the envelope is neutral but the rows are engine-keyed. This slice
defines the neutral row types and makes `QueryResult` generic so the four primitives can narrow their
return, establishing the contract the normalizer (S2) fills.

## Scope

### In

- In the seam (`ts/packages/analytics-kit/src/query-result.ts`), make `QueryResult` generic:
  `QueryResult<TRow = Record<string, unknown>>` with `rows: ReadonlyArray<TRow>`; keep
  `columns`/`generatedAt`/`fromCache?` unchanged.
- Define the four neutral row types (co-located with the query surface — seam package, exported):
  - `TrendRow { bucket: string; value: number; breakdown?: string }`
  - `UniqueCountRow` — alias/same shape as `TrendRow`
  - `FunnelStepRow { step: number; event: string; count: number; conversionRate: number; breakdown?: string }`
  - `RetentionRow { cohort: string; periodIndex: number; value: number; breakdown?: string }`
- Narrow `AnalyticsQueryClient`'s method return types (`ts/packages/node/src/query/query-client.ts`):
  `funnel(): Promise<QueryResult<FunnelStepRow>>`, `retention(): Promise<QueryResult<RetentionRow>>`,
  `trend(): Promise<QueryResult<TrendRow>>`, `uniqueCount(): Promise<QueryResult<UniqueCountRow>>`.
- `rawQuery(expr): Promise<QueryResult>` keeps the default `Record<string, unknown>`.
- Export the new row types from the seam's public surface (`ts/packages/analytics-kit/src/index.ts` — add
  the four row types to the existing `export type { QueryColumn, QueryResult } from './query-result'` line).
- **Confirm the generic-change ripple typechecks across every `QueryResult` consumer.** Making
  `QueryResult` generic (with a default) touches every current reference. Verified against the code: all of
  these must still be `tsc`-green when S1 lands (the builder confirms, does not leave a break for S2/S3):
  - `ts/packages/node/src/query/query-noop.ts` — `emptyResult()` returns a bare `QueryResult`; the five
    `QueryNoop` methods still declare `Promise<QueryResult>`. **Narrow them to match the interface** so
    `QueryNoop implements AnalyticsQueryClient` still satisfies the now-narrowed signatures (e.g.
    `funnel(): Promise<QueryResult<FunnelStepRow>>`). GOTCHA: a bare `QueryResult` (= `QueryResult<Record<string,
    unknown>>`) is NOT assignable to `QueryResult<FunnelStepRow>` (the reverse of the covariant direction),
    so `emptyResult()` returning a bare `QueryResult` will NOT typecheck into a narrowed return. Make
    `emptyResult` GENERIC — `function emptyResult<TRow>(): QueryResult<TRow>` returning `{ rows: [], columns:
    [], generatedAt }` (an empty `TRow[]` satisfies any `TRow`) — and have each method call
    `emptyResult<FunnelStepRow>()` etc. This is the clean fix (no cast). — story-refiner (2026-07-13)
  - `ts/packages/node/src/query/warehouse-query-adapter.ts` — the typed STUB: its five methods declare
    `Promise<QueryResult>` and throw. **Narrow their return signatures to match the interface** exactly as
    `QueryNoop`, so the second-adapter bar-A proof still typechecks against the narrowed
    `AnalyticsQueryClient` (a `throw` body is assignable to any narrowed return).
  - `ts/packages/node/src/query/http-query-adapter.ts` — the five method signatures narrow to match the
    interface; the S1-scope change here is signatures only (`normalizeResult`'s BODY producing the rows is
    S2). S1 may return a temporary `as` cast or leave the body producing `Record<string, unknown>` rows —
    builder's call whether S1+S2 land together (see Out).
  - `ts/packages/node/src/query/create-query-client.ts` — returns `AnalyticsQueryClient<...>`; no signature
    change needed, but confirm it still typechecks against the narrowed `QueryNoop`/`HttpQueryAdapter`.
  - `ts/examples/fernly/src/kpi/snapshots.ts` — `SnapshotRecord.result: QueryResult` (default generic) and
    `snapshot(name, result: QueryResult)` accept a narrowed `QueryResult<FunnelStepRow>` etc. by covariant
    assignability (`ReadonlyArray<TRow>` is covariant). **Verified assignable — no change required.**
  - `ts/examples/fernly/src/capability-presence.ts` — the Layer-2 `*Result` pins
    (`...['funnel'] extends (...args: never[]) => Promise<QueryResult> ? true : false`) stay `true` by
    covariant assignability (`FunnelStepRow extends Record<string, unknown>`, incl. the optional
    `breakdown?`), and `queryKeys` is unaffected (return-type change is invisible to `keyof`).
    **Verified compiles — no change required.** (The pins become strictly weaker — they now assert
    "assignable to bare `QueryResult`", not the exact narrowed row. Optionally tighten to
    `Promise<QueryResult<FunnelStepRow>>` etc. to re-pin the narrowing; not required for green, so out of
    S1's mandatory scope.) — architect variance ruling (2026-07-13)

### Out

- The normalizer changes that actually PRODUCE these rows — that's S2 (this story only declares types;
  the adapter may temporarily cast until S2 lands, or S1+S2 land together — builder's call, but the
  type declarations are S1's deliverable).
- Optional extras (`medianConversionTime`, trend `aggregated`) — deferred (epic Out of scope).
- Docs + the language-neutral artifact — S4.
- **Updating the broken TEST type-pins is S3, not S1.** Narrowing the four primitive returns makes four
  `expectTypeOf<...>().returns.toEqualTypeOf<Promise<QueryResult>>()` assertions in
  `ts/packages/node/src/query/query-client.test.ts` fail (`toEqualTypeOf` is exact-equality; the narrowed
  `QueryResult<FunnelStepRow>` is not equal to the bare `QueryResult`). This is a KNOWN, EXPECTED test break
  that S3 owns and repoints. If S1 and S2 land together, the builder may fix them then to keep the suite
  green, but they are S3's deliverable — do not treat this test break as an S1 regression. — architect
  variance ruling (2026-07-13)

## Acceptance criteria

- [ ] `QueryResult<TRow = Record<string, unknown>>` is generic; default preserves the current shape for
      `rawQuery`.
- [ ] The four row types exist with exactly the fields above and are exported from the seam.
- [ ] The four structured primitives on `AnalyticsQueryClient` narrow their return to the matching row
      type; `rawQuery` stays on the default.
- [ ] No vendor/engine-internal field name appears in any row type.
- [ ] `QueryNoop` and `WarehouseQueryAdapter` method signatures are narrowed to match the interface, so both
      still `implements AnalyticsQueryClient` after the narrowing (both bar-A/bar-B proofs stay green).
- [ ] `build`/`typecheck`/`lint` green; neutrality scan green — INCLUDING the `examples/fernly` package
      (`capability-presence.ts` + `snapshots.ts` verified to compile unchanged; if either goes red, the
      narrowing was applied wrong).

## Technical notes

- `QueryResult`/`QueryColumn` live in the seam package (`@randomtoni/analytics-kit`); the spec types +
  `AnalyticsQueryClient` live in `@randomtoni/analytics-kit-node`. Row types belong with the envelope in
  the seam (they are part of the neutral public surface consumers key on).
- Row-shape source of truth is the architect's contract, locked in the epic `## Notes`:
  `TrendRow { bucket, value, breakdown? }` · `UniqueCountRow` ≡ `TrendRow` · `FunnelStepRow { step,
  event, count, conversionRate, breakdown? }` · `RetentionRow { cohort, periodIndex, value, breakdown? }`.
  — architect (2026-07-13)
- **Field naming is TS camelCase, locked** — `conversionRate` and `periodIndex` are camelCase in the TS
  types (not `conversion_rate`/`period_index`). These are the exact field names; no other casing. The
  language-neutral `planning/` artifact (S4) states the same field concepts for the Python query client to
  port to (Python cases them snake_case). Do not deviate from the field names above. — architect (2026-07-13)
- Breaking: consumers keying on the old engine-internal fields (`row.breakdown_value` etc.) will not
  compile / will get `undefined`. That is intended — it is the whole point of the contract-establishing
  release. — architect (2026-07-13)
