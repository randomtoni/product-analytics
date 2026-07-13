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

> Reviewer suggestion (2026-07-13): `snapshots.test.ts`'s `expectWellFormed` was widened to
> `QueryResult<unknown>` (correct, row-agnostic). If S3/S4 add a row-level well-formedness assertion,
> this helper is the natural home; `unknown` keeps it open to that.
> Reviewer suggestion (2026-07-13): `UniqueCountRow = TrendRow` is a TS alias per the locked contract,
> but the S4 language-neutral artifact should state `UniqueCountRow` as its own named concept (same
> field set) so the Python port doesn't collapse it into `TrendRow` and lose the primitive's identity.

## Shipped

> Captured by `implement-epics` on 2026-07-13.

- **Files changed:** `ts/packages/analytics-kit/src/query-result.ts` (generic `QueryResult<TRow>` + four neutral row types), `ts/packages/analytics-kit/src/index.ts` (seam export of the row types), `ts/packages/node/src/query/query-client.ts` (narrowed the four structured primitives; `rawQuery` on default), `ts/packages/node/src/query/query-noop.ts` (narrowed signatures + generic `emptyResult<TRow>()` no-cast fix), `ts/packages/node/src/query/warehouse-query-adapter.ts` (narrowed signatures), `ts/packages/node/src/query/http-query-adapter.ts` (signature-only narrowing behind a temporary, provenance-commented S1→S2 bridge cast — `run()`/`normalizeResult` body unchanged), `ts/examples/fernly/src/kpi/snapshots.ts` (generic `SnapshotRecord<TRow>`/`snapshot<TRow>` threading — required, not predicted), `ts/examples/fernly/src/kpi/snapshots.test.ts` (`expectWellFormed` widened to `QueryResult<unknown>`), `ts/examples/fernly/src/capability-presence.ts` (the four Layer-2 query pins tightened from bare `QueryResult` to the narrowed row types)
- **Files added:** none
- **New public API:** `TrendRow`, `UniqueCountRow`, `FunnelStepRow`, `RetentionRow` + generic `QueryResult<TRow = Record<string, unknown>>` — all on the seam surface (`@randomtoni/analytics-kit`)
- **Tests added:** none — S1 is pure type-declaration + ripple; test-pin work is S3. Full existing suite (1553) stays green.
- **Commit:** `main` (message = story title)
- **Reviewer notes:** ship-ready, no critical, first review. Row types confirmed genuinely neutral (neutrality 30/30, none of `breakdown_value`/`average_conversion_time`/`aggregation_value`/`converted_people_url` appear). **Closed-type discipline is load-bearing and correct** — no `[k: string]: unknown` index signature added; the 8 tsc errors ("Index signature ... is missing in type 'FunnelStepRow'") are themselves the proof the row types are exact. `capability-presence.ts` pins *tightened* (stronger frozen-surface tripwire), not weakened. Fernly generic threading is scope-justified necessity (the story's "compiles unchanged" prediction was wrong: TS interfaces carry no implicit index signature), correctly handled with a generic not a laundering cast. S1→S2 bridge cast is signature-only, zero runtime impact, adapter-internal. Two suggestions captured above. 8 typecheck failures are exactly and only the S3-owned pins (structured four fail, `rawQuery` passes — positive evidence the narrowing is surgical).
- **Retry history:** none — shipped first attempt.
- **Cross-story seams exposed:** S2 must remove the four `as unknown as Promise<QueryResult<Row>>` bridge casts in `http-query-adapter.ts` by making `normalizeResult` actually produce the typed rows. S3 owns **8** query-client.test.ts breaks (not 4 as the story estimated — 4 arrow-annotation returns at lines ~27/34/37/45 + 4 `toEqualTypeOf` pins at ~103-106); the architect note is to re-annotate the arrow returns to the narrowed row type (positive narrowing pins) rather than widen/drop them and lose coverage. The four row types + generic envelope are the exact contract S2 fills and S4 documents.
