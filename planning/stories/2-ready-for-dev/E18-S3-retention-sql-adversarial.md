---
id: E18-S3-retention-sql-adversarial
epic: E18-QRY-warehouse-query-primitives
status: ready-for-dev
area: query
touches: [adapters, node]
depends_on: [E18-S1-trend-unique-count-sql]
api_impact: additive
---

# E18-S3-retention-sql-adversarial — `retention` as cohort self-join; `period_index=0` = the cohort's own period; adversarial tests

## Why

Retention is the second HARD primitive: a cohort self-join producing a distinct-actor count per
(cohort, period) cell, where **`period_index=0` is the cohort's own period** (not the first return
period). The correctness risk is in the cohort/return bucketing and the period-0 convention, so it is
front-loaded and adversarially tested. Rows must be byte-identical to HTTP retention rows by
construction.

## Scope

### In

- Fill the `retention` body of `WarehouseQueryAdapter` in both trees so it COMPUTES, routing SQL through
  the injected DB-execute seam and returning `QueryResult<RetentionRow>`. Add a `retention` SQL builder
  to the S1 SQL-gen module and a `retention` flat-row builder alongside the S1/S2 builders.
- **The cohort self-join SQL semantics (the correctness core):**
  - **Cohort definition:** actors who did `spec.cohortEvent` in a given period (period = a
    `date_trunc(spec.granularity, timestamp)` bucket). Each such bucket is one cohort, keyed by its
    period start (the neutral `cohort` field, a bucket-start string).
  - **Return measurement:** for each cohort and each period offset `0 .. spec.periods-1`, count
    `count(distinct distinct_id)` of cohort members who did `spec.returnEvent` in the cohort-period
    plus that offset.
  - **`period_index=0` is the cohort's OWN period (locked convention).** The period-0 cell is the
    cohort's own bucket (the base cohort size measured via the return event in the cohort's period),
    NOT the first subsequent return period. period_index 1 = the next `granularity` bucket, etc. —
    exactly the HTTP adapter's `retentionCohorts` fixture (index 0 = the cohort itself).
  - Self-join the typed view: cohort rows (`spec.cohortEvent`) against return rows
    (`spec.returnEvent`) bucketed by `spec.granularity` for `spec.periods` periods.
  - **Dense grid via `generate_series` (PINNED — architect consult, story-refiner 2026-07-14).** Emit
    a row for EVERY `(cohort, period_index)` cell over `0 .. periods-1`, including zero cells. Generate
    the grid — `generate_series(0, spec.periods - 1)` cross-joined against the distinct cohort buckets —
    and LEFT JOIN the distinct-actor counts onto it, so an empty cell surfaces as `value: 0` rather than
    a missing row. This is the DENSE convention (chosen over sparse) so the result row count is
    deterministic (`cohorts × periods`) and easy to assert against a canned fixture. It stays a SINGLE
    statement.
  - `breakdown` when present: `GROUP BY (properties->>'<breakdown>')` (same JSONB-path posture as
    S1/S2), one cohort/period grid per breakdown value, stringified onto every row.
- **The flat-row builder** flattens positional `DbExecuteResult.rows` into `RetentionRow`
  (`{ cohort, periodIndex, value, breakdown? }`) — one row per (cohort, period_index) cell, reusing the
  S1 shared assembler for `columns`/`generatedAt`.
- **Adversarial unit tests (required, against the E17-S3 fake `DbExecute`):**
  - **period_index=0 = cohort's own period** — assert the period-0 value is the cohort base, not the
    first return period (the most common off-by-one).
  - **actor in multiple cohorts** — an actor doing `cohortEvent` in two periods appears in both cohorts;
    distinct-count per cell is per-cohort, not global.
  - **return outside the periods window** — a return event past `spec.periods` buckets contributes to
    no cell (bounded grid).
  - **no-return actor** — a cohort member who never returns is counted in period 0 but decays in later
    periods.
  - **empty/sparse cohort** — a cohort with a zero cell still emits a row with `value: 0` (grid is
    dense over `0 .. periods-1`, no gaps).
- **TS/Python parity:** same self-join SQL semantics, same period-0 convention, same flat-row builder,
  same neutral rows, same adversarial cases in both trees' tests.

### Out

- `trend`/`unique_count` — **S1**. `funnel` — **S2**. `raw_query` + dialect-split doc — **S4**.
  Row-parity proof — **S5**.
- Byte-exact HogQL retention parity — explicitly OUT (documented divergence).
- Retention math variants beyond the cohort/return grid (e.g. rolling/unbounded retention modes) — out;
  anything beyond the spec's four fields stays behind `rawQuery`.
- Any seam/config/factory/typed-view change — **E17** (consumed read-only). Real Postgres — **E21**.

## Acceptance criteria

- [ ] `retention` COMPUTES in both trees, routing SQL through the injected `DbExecute` seam and
      returning `QueryResult<RetentionRow>`.
- [ ] The SQL self-joins cohort (`spec.cohortEvent`) against return (`spec.returnEvent`) bucketed by
      `spec.granularity` for `spec.periods` periods, counting `count(distinct distinct_id)` per (cohort,
      period) cell — verified by the adversarial tests.
- [ ] `period_index=0` is the cohort's OWN period (asserted explicitly) — matching the `retentionCohorts`
      contract; period_index 1..N are subsequent buckets.
- [ ] Rows match `RetentionRow` exactly (`{ cohort, periodIndex, value, breakdown? }`); the grid is
      dense (`value: 0` for empty cells, no gaps); no engine wire field (`breakdown_value`) leaks.
- [ ] With `spec.breakdown`, one cohort/period grid per breakdown value, stringified onto every row.
- [ ] The multiple-cohorts, return-outside-window, no-return, and sparse-cohort adversarial cases pass.
- [ ] TS/Python parity on SQL semantics, the period-0 convention, and the adversarial cases; tests run
      against the E17-S3 fake (no real Postgres); both neutrality scans green; all gates green in both
      trees.

## Technical notes

Builds on S1's SQL-gen module + shared assembler (reuse both; add a `retention` builder). S2/S3/S4 edit
the same adapter file + SQL-gen module and run sequentially in practice.

**Orchestrator sequencing (story-refiner 2026-07-14):** S2/S3/S4 are dependency-parallel off S1 but all
edit the SAME adapter + `warehouse-sql` files in both trees — run them **serially S2 → S3 → S4** (not
parallel) to avoid shared-file merge friction. Run-ordering recommendation only; the `depends_on` graph
is correct as-is.

**Pre-resolved decisions (locked by the epic Notes + user decision — do NOT re-litigate):**

- **`period_index=0` is the cohort's own period (locked convention).** Not the first return period.
  Matches the HTTP `retentionCohorts` fixture (index 0 = the cohort itself). This is the chosen,
  documented convention (epic Notes; Success criteria). — architect (2026-07-13) + user decision
- **Single SQL statement, dense grid, one canned result (architect consult, story-refiner
  2026-07-14).** The whole retention grid is expressible as ONE statement returning one row per
  `(cohort, period_index[, breakdown])` cell with its `count(distinct distinct_id)` — the self-join,
  the `generate_series(0, periods-1)` dense grid, and the per-cell aggregation all resolve inside one
  statement (no round-trip per cohort or per period). So the `retention` method makes ONE `DbExecute`
  call and normalizes ONE `DbExecuteResult`; do NOT build the per-call SQL-keyed resolver variant of the
  fake — a single canned result per method call drives every adversarial case. The DENSE (zero-filled)
  convention is pinned: emit every cell over `0 .. periods-1` including zeros (see Scope).
- **Documented divergence, NOT byte-exact HogQL parity (user decision).** Greenfield consumer, no
  PostHog data to match. Ship correct, well-defined cohort-retention semantics with the period-0
  convention documented — no chase for HogQL's exact retention algorithm, no
  posthog-source-guide-vs-server dependency.
- **CRITICAL — own FLAT builder, not the HTTP nested builder (architect, E17-S3 review 2026-07-14).**
  The HTTP `buildRetentionRows` (`http-query-adapter.ts:362`) reads engine-nested cohort objects
  (`date` + an indexed `values: {count}[]` array, the array index = the period). The warehouse builder
  flattens positional `DbExecuteResult.rows` into the SAME `RetentionRow` type. Reuse the row TYPE + the
  period_index=0 RULE, not the nested builder. Proven identical in S5.
- **Adapter fills stub against the injected seam — no seam/factory change** (E17-S4). **Testable against
  the E17-S3 fake** — TS `import { createFakeDbExecute } from '../query/db-execute.fixtures'`; Python
  `from db_execute_fakes import FakeDbExecute`. Assert SQL shape + flat-row flattening + the period-0
  cell against canned `DbExecuteResult`s; **no real Postgres**. **Postgres ≥16** is a query-time note
  only.

**Reference pointers:**
- Spec: `RetentionSpec` (`query-client.ts:25-31`): `cohortEvent`, `returnEvent`, `periods: number`,
  `granularity: 'day'|'week'|'month'`, `breakdown?`. Python mirror in `client.py`.
- Row + convention: `RetentionRow` (`query-result.ts:29-34`); the `retentionCohorts` fixture
  (`query-contract.fixtures.ts`) — index 0 = the cohort itself, one row per (cohort, periodIndex) cell
  (S5 asserts it).
- Assembler pattern to reuse from S1: the warehouse `normalizeResult` analog.

## Shipped
