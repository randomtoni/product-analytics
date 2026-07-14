---
id: E18-S2-funnel-sql-adversarial
epic: E18-QRY-warehouse-query-primitives
status: ready-for-dev
area: query
touches: [adapters, node]
depends_on: [E18-S1-trend-unique-count-sql]
api_impact: additive
---

# E18-S2-funnel-sql-adversarial — `funnel` as per-actor ordered-step-within-window SQL; conversionRate computed in the normalizer; adversarial tests

## Why

Funnel is the first HARD primitive: it needs per-actor ordered-step-within-window SQL with strictly
increasing step timestamps inside `spec.within`, **window measured from step 0**. The correctness risk
is entirely in the SQL semantics and the boundary behavior, so this slice is front-loaded and
adversarially tested. `conversionRate` stays COMPUTED in the flat-row builder (the normalizer), never
in SQL — so warehouse funnel rows are byte-identical to HTTP funnel rows by construction.

## Scope

### In

- Fill the `funnel` body of `WarehouseQueryAdapter` in both trees so it COMPUTES, routing SQL through
  the injected DB-execute seam and returning `QueryResult<FunnelStepRow>`. Add a `funnel` SQL builder to
  the S1 SQL-gen module and a `funnel` flat-row builder alongside the S1 trend builder.
- **The per-actor ordered-step-within-window SQL semantics (the correctness core):**
  - For each `distinct_id`, find whether they completed `spec.steps` **in order** with **strictly
    increasing step timestamps** (step N's event strictly after step N−1's), all within `spec.within`
    (a `Duration`) **measured from the step-0 event timestamp** — NOT a rolling per-adjacent-pair
    window. Actor's step-0 time anchors the window; every later completed step must fall within
    `[t0, t0 + within]`.
  - Produce per-step completion counts: `count(distinct distinct_id)` of actors who reached step N
    (having satisfied all prior steps in order within the window). Step 0's count is the base; each
    later step's count is monotonically non-increasing.
  - `breakdown` when present: `GROUP BY (properties->>'<breakdown>')` (same JSONB-path posture as S1),
    with per-GROUP counts — each group's step-0 count is that group's base.
  - **Approach family PINNED (architect consult, story-refiner 2026-07-14): the per-actor
    ordered-step window-function walk** — filter the view to the `spec.steps` events
    (`WHERE event IN (...)`), tag each with its step index, anchor `t0` per actor via
    `min(timestamp) FILTER (WHERE step = 0)`, then a window-function progress check enforcing
    strictly-increasing step timestamps within `[t0, t0 + within]`; emit per-step distinct-actor
    counts. Reason it is pinned over the alternative: `spec.steps` is arbitrary length, and the
    window-walk keeps the emitted statement **structurally CONSTANT** regardless of step count (only
    the step-set predicate varies) — friendlier to byte-reproducible SQL across both trees and the
    Python parity port than the variadic N-way self-join. **Rejected alternative (name it so a reviewer
    doesn't flag its absence): the self-join chain** (join step-0→step-1→… per `distinct_id` with the
    t0-anchored window predicate) is correct but variadic-shape (join count = `spec.steps.length`),
    so it is NOT chosen. If the builder finds a materially clearer single-statement walk, it may
    diverge — but stay single-statement (see the fake note) and document the choice.
- **`conversionRate` is COMPUTED in the flat-row builder, NEVER in SQL (locked).** The SQL yields per-
  step (and per-group) `count`s only. The funnel flat-row builder computes `conversionRate =
  count[step] / count[0]` **guarded** (count[0] === 0 ⇒ conversionRate 0 for every step, no
  NaN/Infinity leak) — matching the HTTP adapter and `funnelPlain`/`funnelZeroFirstStep` fixtures
  exactly. Produce `FunnelStepRow` (`{ step, event, count, conversionRate, breakdown? }`).
- **`event` on the row** is the step's neutral event name — here it comes straight from `spec.steps[n]`
  (the SQL restricts each step to its named event), NOT from the HTTP adapter's
  `custom_name→name→action_id` wire-precedence walk (that is engine-shaped; the warehouse knows the
  event name from the spec). Document this divergence: same neutral `event` field, sourced from the spec.
- **Adversarial unit tests (required, against the E17-S3 fake `DbExecute`):**
  - **out-of-order events** — an actor firing step 2's event before step 1's does NOT count as completing
    the funnel (strict ordering enforced).
  - **boundary-of-window** — an actor completing the last step exactly at `t0 + within` COUNTS; one
    tick past does NOT. The boundary is **PINNED INCLUSIVE** (architect consult, story-refiner
    2026-07-14): the window is the closed interval `[t0, t0 + within]`, upper-bound step predicate
    `timestamp <= t0 + within` (NOT `<`). This is not an open decision — assert exactly-at-boundary
    counts and one-tick-past does not.
  - **partial completion** — an actor reaching step 1 but not step 2 counts toward step 1's count, not
    step 2's; per-step monotonic non-increase holds.
  - the two `conversionRate` guard cases (normal ratios + count[0]===0 ⇒ all-zero).
- **TS/Python parity:** same SQL semantics (ordering, window-from-step-0, boundary rule), same
  guarded-conversionRate builder, same neutral rows, same adversarial cases in both trees' tests.

### Out

- `trend`/`unique_count` — **S1** (shipped; S2 reuses its SQL-gen module + assembler). `retention` —
  **S3**. `raw_query` + dialect-split doc — **S4**. Row-parity proof — **S5**.
- Byte-exact HogQL funnel parity (e.g. PostHog's `average_conversion_time`, `median_conversion_time`,
  `converted_people_url`) — explicitly OUT (documented divergence; those wire fields never surface, and
  the deferred additive `medianConversionTime` is an Expansion-path follow-up, not this story).
- Any seam/config/factory/typed-view change — **E17** (consumed read-only).
- Real Postgres — **E21**.

## Acceptance criteria

- [ ] `funnel` COMPUTES in both trees, routing SQL through the injected `DbExecute` seam and returning
      `QueryResult<FunnelStepRow>`.
- [ ] The SQL enforces per-actor ordered steps with strictly increasing step timestamps, all within
      `spec.within` **measured from step 0** — verified by the out-of-order, boundary, and
      partial-completion adversarial tests.
- [ ] `conversionRate` is computed in the flat-row builder (NOT in SQL) as guarded `count[step]/count[0]`
      (count[0]===0 ⇒ 0 on every step) — matching the `funnelPlain`/`funnelZeroFirstStep` contract.
- [ ] Rows match `FunnelStepRow` exactly (`{ step, event, count, conversionRate, breakdown? }`); `event`
      is sourced from `spec.steps`; no engine wire field (`average_conversion_time`,
      `converted_people_url`, `breakdown_value`) leaks onto a row.
- [ ] With `spec.breakdown`, the SQL groups per breakdown value and conversionRate is per-group; the
      breakdown is stringified onto every row.
- [ ] The window boundary is INCLUSIVE (closed `[t0, t0 + within]`, predicate `<=`) — asserted:
      completion exactly at `t0 + within` counts, one tick past does not.
- [ ] TS/Python parity on SQL semantics, the guarded-conversionRate builder, and the adversarial cases;
      tests run against the E17-S3 fake (no real Postgres); both neutrality scans green; all gates green
      in both trees.

## Technical notes

Builds directly on S1: reuse S1's SQL-gen module (add a `funnel` builder) and S1's shared assembler
(the `normalizeResult` analog). S2, S3, S4 all edit the same adapter file + SQL-gen module, so they run
sequentially in practice (all `depends_on` S1's pattern).

**Orchestrator sequencing (story-refiner 2026-07-14):** the graph is `S1 → { S2, S3, S4 } → S5`, so
S2/S3/S4 are dependency-parallel — but all three edit the SAME two files in both trees
(`warehouse-query-adapter.ts`/`warehouse_adapter.py` + the S1 `warehouse-sql` module), each adding one
method body + one builder. Run them **serially in the order S2 → S3 → S4**, NOT in parallel, to avoid
merge friction on the shared adapter/SQL-gen files. This is a run-ordering recommendation only; the
`depends_on` graph is correct as-is (each genuinely depends only on S1's pattern).

**Pre-resolved decisions (locked by the epic Notes + user decision — do NOT re-litigate):**

- **Window measured from step 0 (locked convention).** The within-window anchors on the actor's step-0
  timestamp — `[t0, t0 + spec.within]` — NOT a rolling per-adjacent-pair window. This is the chosen,
  documented convention (epic Notes; Success criteria). — architect (2026-07-13) + user decision
- **Single SQL statement, one canned result (architect consult, story-refiner 2026-07-14).** The whole
  funnel is expressible as ONE statement returning all per-step distinct-actor counts as `N` rows
  (one per step; `(step_index, event, actor_count[, breakdown])`), so the `funnel` method makes ONE
  `DbExecute` call and normalizes ONE `DbExecuteResult`. Do NOT split into a query-per-step or build the
  per-call SQL-keyed resolver variant of the fake — a single canned `DbExecuteResult` per method call is
  sufficient for every adversarial case (drive each case by handing the fake the step-count rows that
  scenario's SQL would return). The row-builder receives the step-ordered count rows and computes
  `conversionRate` across them.
- **`conversionRate` COMPUTED in the normalizer, not SQL (locked).** SQL yields counts; the builder
  divides `count[step]/count[0]` guarded. This is what makes warehouse funnel rows byte-identical to HTTP
  rows — both compute conversionRate the same way from counts. Mirror the HTTP builder's guard
  (`funnelZeroFirstStep`: count[0]===0 ⇒ 0). — epic Notes / architect (2026-07-13)
- **Documented divergence, NOT byte-exact HogQL parity (user decision).** Greenfield consumer, no
  PostHog data to match. Ship correct, well-defined ordered-funnel semantics with the window-from-step-0
  convention documented — no chase for HogQL's exact funnel algorithm, no posthog-source-guide-vs-server
  dependency. Do NOT spawn posthog-source-guide to match PostHog's funnel math.
- **CRITICAL — own FLAT builder, not the HTTP nested builder (architect, E17-S3 review 2026-07-14).**
  The HTTP `buildFunnelRows` (`http-query-adapter.ts:297`) reads engine-nested step objects
  (`order`/`count`, array-of-arrays for breakdown, the `custom_name→name→action_id` event walk). The
  warehouse builder flattens positional `DbExecuteResult.rows` into the SAME `FunnelStepRow` type,
  sourcing `event` from `spec.steps` and computing conversionRate itself. Reuse the row TYPE + the
  guarded-conversionRate RULE, not the nested builder. Proven identical in S5.
- **Adapter fills stub against the injected seam — no seam/factory change** (E17-S4 already made it
  constructable/selectable). **Testable against the E17-S3 fake** — TS
  `import { createFakeDbExecute } from '../query/db-execute.fixtures'`; Python
  `from db_execute_fakes import FakeDbExecute`. Assert SQL shape + the flat-row flattening +
  conversionRate against canned `DbExecuteResult`s; **no real Postgres**. **Postgres ≥16** is a
  query-time note only.

**Reference pointers:**
- Spec: `FunnelSpec` (`query-client.ts:19-23`): `steps: (keyof events)[]`, `within: Duration`,
  `breakdown?`. Python mirror in `client.py`.
- Row + guard contract: `FunnelStepRow` (`query-result.ts:21-27`); `funnelPlain` /
  `funnelZeroFirstStep` / `funnelEventPrecedence` / `funnelBreakdown` fixtures
  (`query-contract.fixtures.ts`) — the exact conversionRate + guard behavior to match (S5 asserts it).
- Assembler pattern to reuse from S1: the warehouse `normalizeResult` analog.

> Reviewer suggestion (2026-07-14): NULL-breakdown row heterogeneity — when broken down by a key some
> actors lack, those rows drop the `breakdown` field while siblings keep it (mirrors S1 trend null
> handling exactly, so consistent). Worth a one-line "NULL breakdown → own bucket" decision when
> breakdown edge behavior is formalized; no change here.
> Reviewer suggestion (2026-07-14) → E21: the adversarial counts are asserted-by-fiat against the fake
> (honest, NOT tautological — the byte-equal `CANONICAL_FUNNEL_SQL` + predicate-presence/absence tests
> WOULD fail on a wrong predicate), but they don't prove the SQL COMPUTES the counts. The reviewer
> closed that gap out-of-band against real Postgres 16.14; E21's real-Postgres acceptance test should
> re-run these exact funnel scenarios so count-faithfulness is machine-checked, not reviewer-checked.

## Shipped

> Captured by `implement-epics` on 2026-07-14.

- **Files changed:** TS `warehouse-sql.ts` (+ `buildFunnelSql`, `buildFunnelRows`), `warehouse-query-adapter.ts` (+ `.test.ts`); Python `warehouse_sql.py` (+ `build_funnel_sql`, `build_funnel_rows`), `warehouse_adapter.py` (+ `tests/test_warehouse_query_adapter.py`)
- **New public API:** none consumer-facing (adapter-internal SQL-gen; reached via `createQueryClient`)
- **Tests added:** TS 14 + Python 14 funnel tests — SQL shape (t0 anchor, strict `>`, inclusive `<=`, `< …` absent, `count(DISTINCT …)`, `WITH RECURSIVE`, params), structural-constancy across step arity, byte-identical `CANONICAL_FUNNEL_SQL`, **adversarial** (out-of-order, boundary-inclusive at/one-past, partial-completion monotonicity), conversionRate guard (zero-first all-zero + normal), per-group breakdown, no-engine-field key seal — all against the E17-S3 fake
- **Commit:** this story's ship commit on `main` (see `git log`)
- **Reviewer notes:** independent gate verdict SHIP (no criticals) — funnel semantics independently confirmed against real Postgres 16.14 (strict-ordering tie-leak avoided, non-rolling window trap survived, greedy-optimal); 2 forward suggestions captured above
- **Cross-story seams exposed:** funnel SQL is a single `WITH RECURSIVE` walk (structurally constant across step count) reusing S1's `assembleResult` + `WarehouseQuery`; `conversionRate` computed in the builder (guarded count[0]===0⇒0); `event` from `spec.steps`; breakdown anchored to each actor's step-0 value; step names bound as params. **S3 (retention) + S4 (raw_query) add their builders to the same `warehouse-sql` module** — run serially (shared files). **E21:** re-run funnel (+ retention) adversarial scenarios against real Postgres.
