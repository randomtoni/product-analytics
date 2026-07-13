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
- Export the new row types from the seam's public surface.

### Out

- The normalizer changes that actually PRODUCE these rows — that's S2 (this story only declares types;
  the adapter may temporarily cast until S2 lands, or S1+S2 land together — builder's call, but the
  type declarations are S1's deliverable).
- Optional extras (`medianConversionTime`, trend `aggregated`) — deferred (epic Out of scope).
- Docs + the language-neutral artifact — S4.

## Acceptance criteria

- [ ] `QueryResult<TRow = Record<string, unknown>>` is generic; default preserves the current shape for
      `rawQuery`.
- [ ] The four row types exist with exactly the fields above and are exported from the seam.
- [ ] The four structured primitives on `AnalyticsQueryClient` narrow their return to the matching row
      type; `rawQuery` stays on the default.
- [ ] No vendor/engine-internal field name appears in any row type.
- [ ] `build`/`typecheck`/`lint` green; neutrality scan green.

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
