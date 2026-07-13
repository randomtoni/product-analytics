---
id: E15-S2-per-primitive-normalizers
epic: E15-QRY-response-row-contract
status: ready-for-dev
area: query
touches: [node, adapters]
depends_on: [E15-S1-neutral-row-types]
api_impact: breaking
---

# E15-S2-per-primitive-normalizers — Per-primitive normalizers in the HTTP query adapter

## Why

The types exist (S1); now the adapter must actually PRODUCE them. This slice replaces the leaking
columns-absent pass-through with per-primitive normalizers that flatten each wire insight shape into its
neutral row type — the fix that closes the leak.

## Scope

### In

- In `ts/packages/node/src/query/http-query-adapter.ts`, split `normalizeResult`'s **columns-absent**
  branch (~line 205) into four per-primitive normalizers (one per structured method), each mapping its
  wire insight result into the matching neutral row type from S1.
- Each `funnel`/`retention`/`trend`/`uniqueCount` method routes its wire result through its own
  normalizer; each **flattens** the nested/parallel-array insight structure to **one neutral row per
  data cell**, producing exactly its S1 row type — including COMPUTING `funnel.conversionRate` as
  `count[i]/count[0]` (not a wire field; see Technical notes).
- **Thread the per-primitive normalizer through the shared `run`/`normalizeResult` seam.** Today
  `funnel`/`trend`/… all call `this.run(query)`, `run` calls `normalizeResult(body, ...)`, and the async
  `resultFrom` also calls `normalizeResult(status, ...)` — `run` is generic over `WireQueryNode` and does
  NOT know which primitive it serves. To route per-primitive WITHOUT duplicating the async/poll plumbing,
  pass a per-primitive normalizer (a `(source: WireResultBearing) => ReadonlyArray<TRow>` row-builder, or a
  discriminator the shared normalizer switches on) DOWN through `run` → `pollToCompletion` → `resultFrom`,
  so the SAME normalizer applies whether the result arrives inline (sync) or via poll (async). Keep the
  shared envelope handling (`results`-present guard, `columns`/`generatedAt`/`fromCache`, the neutral
  did-not-complete error) in one place; only the ROW-building step becomes per-primitive. — architect
  (2026-07-13)
- Wire the async/poll completion path (`resultFrom` / `pollToCompletion`) through the same per-primitive
  normalizer so sync ≡ async at the row level (the async path currently reuses the shared
  `normalizeResult`).
- Keep the **columns-PRESENT** branch (the `rawQuery` cell-array zip) exactly as-is — those columns are
  the consumer's own SELECT projection and are already neutral.
- **`rawQuery` keeps the CURRENT shared normalizer (both branches) unchanged** — it is the ONE primitive
  that is NOT per-primitive-flattened. Under the new routing, `rawQuery`'s normalizer is exactly today's
  `normalizeResult` (columns-present → zip; columns-absent → object pass-through, keeping the existing
  `isRecord` filter). Only `funnel`/`retention`/`trend`/`uniqueCount` get flattening normalizers. The
  columns-absent OBJECT-passthrough behavior must survive FOR `rawQuery` (the async
  `rawQuery`-with-object-rows test in `http-query-adapter-async.test.ts` depends on it).
- All engine-internal keys (`breakdown_value`, `average_conversion_time`, `aggregation_value`,
  `converted_people_url`, ...) are consumed inside the normalizers and never appear on the returned rows.

### Out

- The type declarations — S1.
- Test inversion + fixtures — S3 (this story makes the code correct; S3 proves it).
- README + parity artifact — S4.
- Optional extras — deferred (epic Out of scope). Do not add `medianConversionTime` / `aggregated`.

## Acceptance criteria

- [ ] `funnel`/`retention`/`trend`/`uniqueCount` return rows in the neutral S1 shapes; no engine-internal
      key survives into a returned row.
- [ ] Each normalizer flattens to one row per data cell; the mapping is lossless on the real data values.
- [ ] `funnel.conversionRate` is COMPUTED (`count[i]/count[0]`, guarded for `count[0] === 0`), not passed
      from a wire field; `funnel.event` resolves from `custom_name`/`name`/`action_id` (first present).
- [ ] `trend`/`uniqueCount` share ONE normalizer (identical wire shape); breakdown yields one row-series
      per breakdown-value entry.
- [ ] `rawQuery` keeps the current shared normalizer (both branches) — its columns-present zip AND its
      columns-absent object pass-through are behaviorally unchanged.
- [ ] The columns-present (`rawQuery`) branch is byte-for-byte unchanged in behavior.
- [ ] Sync and async completion paths yield identical neutral rows for the same wire result (the
      per-primitive normalizer threads through both `run` and `resultFrom`).
- [ ] The existing async-path tests still pass; `build`/`typecheck`/`lint` + neutrality scan green.

## Technical notes

- The wire insight shapes are NOT in `posthog-js` (write-path-only SDK); they live in the PostHog server
  repo. `posthog-source-guide` resolved the authoritative field names + nesting (2026-07-13), pinned below.
  PostHog types trends/funnel result items as `Record<string, any>` server-side, so treat the wire as
  untrusted and map DEFENSIVELY (mirror the existing `isRecord` guard discipline; coerce/skip missing or
  wrong-typed cells rather than throwing). — architect + posthog-source-guide (2026-07-13)
- **Exact per-primitive flatten mappings (pinned — build to these):**
  - **`trend` / `uniqueCount` → `TrendRow { bucket, value, breakdown? }`.** Each entry in the wire `results`
    array carries two POSITIONALLY-PARALLEL arrays: `days: string[]` (ISO bucket dates) and `data:
    number[]` (one value per bucket). Emit one row per index: `{ bucket: days[i], value: data[i] }`. When a
    `breakdownFilter` was sent, PostHog returns **one separate top-level `results` entry PER breakdown
    value**, each carrying its own `days`/`data` plus a `breakdown_value` field — flatten each entry's
    buckets into rows and set `breakdown` from that entry's `breakdown_value` (stringified). `uniqueCount`
    is byte-identical to `trend` on the wire (same `days`/`data`, only the server-side math differs) — use
    the SAME normalizer, no branching.
  - **`funnel` → `FunnelStepRow { step, event, count, conversionRate, breakdown? }`.** The wire `results` is
    an array of per-step objects (an array-of-arrays when broken down — unwrap the outer layer per breakdown
    group). Each step object carries `order` (0-based step index), `count` (number reaching the step), and
    `name` / `action_id` / `custom_name` for the event identity. Map: `step` ← `order`; `event` ← the step
    event name (prefer `custom_name`, else `name`, else `action_id` — pick the first present non-empty
    string); `count` ← `count`. **`conversionRate` is NOT a wire field — COMPUTE it** as
    `count[stepIndex] / count[0]` (overall conversion from the first step; guard `count[0] === 0` → `0`).
    When broken down, set `breakdown` from the group's `breakdown_value`.
  - **`retention` → `RetentionRow { cohort, periodIndex, value, breakdown? }`.** The wire `results` is an
    array of cohort objects, each with `date` (the cohort's start, ISO) and a `values: { count: number }[]`
    array — one cell per period, where the ARRAY INDEX is the period (index 0 = the cohort itself). Double
    loop: for each cohort, for each cell index `j` → `{ cohort: cohort.date, periodIndex: j, value:
    values[j].count }`. Set `breakdown` from the cohort's `breakdown_value` when present.
  - One row per cell keeps it native to a SQL `GROUP BY` and cleanly Python-portable. — posthog-source-guide
    + architect (2026-07-13)
- **`conversionRate` field-name discipline (locked).** It is camelCase `conversionRate` in the TS type
  (matches S1). The derivation `count[i]/count[0]` is the library's own normalization responsibility — the
  wire never sends a rate. Do NOT name it `conversion_rate` and do NOT pass a wire field through.
- **`converted_people_url` is NOT on this wire path** (it's a legacy filter-based funnel surface, absent
  from the HogQL query-runner response). It will trivially not appear in the funnel rows; the S3 seal test
  asserting its absence still holds. Do not map any `*_people_url` field. — posthog-source-guide (2026-07-13)
- The columns-absent branch is the ONLY leak; do not touch the columns-present zip. — architect (2026-07-13)
- **S1↔S2 seam (verified no drift):** the normalizers here produce EXACTLY the S1 row types, field-for-field
  — `TrendRow { bucket, value, breakdown? }`, `FunnelStepRow { step, event, count, conversionRate,
  breakdown? }`, `RetentionRow { cohort, periodIndex, value, breakdown? }`, `UniqueCountRow ≡ TrendRow`.
  camelCase, no `conversion_rate`/`period_index`. If S1 and S2 land together, the normalizer return types
  are these S1 types directly (no temporary cast); if S1 landed first, replace any temporary cast S1 left in
  the adapter body with the real flatten. — story-refiner (2026-07-13)

> Reviewer suggestion (2026-07-13): S2 ships the leak-closing normalizers with ZERO positive test
> coverage — no fixture exercises a real `days`/`data`, `order`/`count`, or `date`/`values` insight
> shape, so the pinned mappings are verified only by code reading. S3's fixtures MUST cover: trend
> breakdown (multi-entry `breakdown_value`), funnel array-of-arrays breakdown with per-group
> `conversionRate`, the `count[0]===0→0` guard, the `custom_name→name→action_id` precedence, and
> retention `periodIndex` 0 = cohort-itself.
> Reviewer suggestion (2026-07-13): S3's envelope-seal test could assert `columns: []` for the
> structured primitives (real trend/funnel/retention responses have no `source.columns`; a spurious
> columns array would flatten `.rows` correctly but still carry the spurious names on `result.columns`
> — harmless since the structured contract doesn't key on `columns`, but worth pinning).

## Shipped

> Captured by `implement-epics` on 2026-07-13.

- **Files changed:** `ts/packages/node/src/query/http-query-adapter.ts` (+234/-66) — split `normalizeResult`'s columns-absent branch into four per-primitive flattening builders (`buildTrendRows` shared by trend+uniqueCount, `buildFunnelRows`, `buildRetentionRows`, `buildRawRows` for rawQuery); threaded a `RowBuilder<TRow>` closure through the shared `run<TRow>` → `pollToCompletion<TRow>` → `resultFrom<TRow>` seam; removed S1's four temporary bridge casts.
- **Files added:** none
- **New public API:** none — behavior only; the seam types were S1. The four structured primitives now RETURN their neutral rows (contract now honored, not just typed).
- **Tests added:** none — S3 owns test authoring. Builder verified all pinned mappings via a throwaway scratch spec (9 scenarios, all passed, then deleted).
- **Commit:** `main` (message = story title)
- **Reviewer notes:** ship-ready, no critical, first review. **Leak structurally closed** — sealed keys (`aggregation_value`, `average_conversion_time`, `converted_people_url`) referenced NOWHERE in the file (grep-verified); `breakdown_value`/`order`/`action_id` consumed inside builders, re-emitted only as neutral fields. All four pinned mappings verified field-by-field. `conversionRate` computed (`count/firstCount` guarded, per-breakdown-group), camelCase. rawQuery byte-for-byte unchanged (default `rowBuilder = buildRawRows`). Structured builders correctly ignore `columns` entirely (columns is HogQL/rawQuery-only; a fallback would reopen the leak). Sync≡async threading GENUINE (reviewer confirmed via the async-equality test — had `resultFrom` not carried the builder, async would have fallen back to zipped rows and broken equality). Defensive mapping disciplined (skip/coerce, never throw).
- **THE key review call — 4 failing node tests independently verified as S3-owned stale-fixture inversions, NOT regressions.** Reviewer read each of `http-query-adapter.test.ts:188` (sync trend), `http-query-adapter-async.test.ts:86/135/212` (async trend/funnel) and confirmed each routes a columns-present cell-array fixture through a STRUCTURED primitive (a wire state that never occurs), fails ONLY on `.rows` content, and passes every poll/GET/error/bounded-termination assertion. Ran the skeptical counter-checks (rawQuery pass-through, sync≡async equality, bounded termination, error/guard paths) — all held. S3 owns inverting these + adding realistic per-primitive fixtures.
- **Retry history:** none — shipped first attempt.
- **Cross-story seams exposed:** node suite is 328/332 + 8 typecheck pins at S2 close — **S3 must clear ALL of it**: invert the 4 stale cell-array fixtures (`http-query-adapter.test.ts:188` + async `:86/135/212`) to realistic insight-shape fixtures, invert the pass-through-pinning test (`:260`), repoint the 8 `query-client.test.ts` type-pins, extend the envelope-seal to the row level, and add the positive per-primitive coverage the reviewer enumerated (see suggestions above). After S3 the full suite + typecheck must be green.
