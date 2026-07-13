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
  data cell**.
- Wire the async/poll completion path (`resultFrom` / `pollToCompletion`) through the same per-primitive
  normalizers so sync ≡ async at the row level (the async path currently reuses the shared
  `normalizeResult`).
- Keep the **columns-PRESENT** branch (the `rawQuery` cell-array zip) exactly as-is — those columns are
  the consumer's own SELECT projection and are already neutral.
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
- [ ] The columns-present (`rawQuery`) branch is byte-for-byte unchanged in behavior.
- [ ] Sync and async completion paths yield identical neutral rows for the same wire result.
- [ ] The existing async-path tests still pass; `build`/`typecheck`/`lint` + neutrality scan green.

## Technical notes

- Confirm the exact wire insight shapes per primitive before mapping — route "how does PostHog shape the
  trends/funnels/retention insight response" through `posthog-source-guide` (or read the wire fixtures S3
  captures). PostHog types these as `Record<string, any>` server-side, so treat the wire as untrusted and
  map defensively (mirror the existing `isRecord` guard discipline). — architect (2026-07-13)
- Flatten mapping intent (architect): trend/uniqueCount → time buckets become `{ bucket, value }` per
  point, `breakdown` split into one row-series per breakdown value; funnel → `{ step, event, count,
  conversionRate }` per step; retention → `{ cohort, periodIndex, value }` per cohort×period cell. One
  row per cell keeps it native to a SQL `GROUP BY` and cleanly Python-portable. — architect (2026-07-13)
- The columns-absent branch is the ONLY leak; do not touch the columns-present zip. — architect (2026-07-13)
