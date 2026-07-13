---
id: E16-S2-per-primitive-normalizers
epic: E16-QRY-python-row-contract
status: ready-for-dev
area: query
touches: [node, adapters]
depends_on: [E16-S1-neutral-row-types]
api_impact: breaking
---

# E16-S2-per-primitive-normalizers — Per-primitive normalizers in the Python HTTP query adapter

## Why

The row types exist (S1); now the adapter must actually PRODUCE them. This slice replaces the leaking
columns-absent pass-through with per-primitive normalizers that flatten each wire insight shape into
its neutral row type — the fix that closes the leak. It mirrors TS E15-S2.

## Scope

### In

- In `python/src/analytics_kit/query/http_adapter.py`, split `_normalize_result`'s **columns-absent**
  branch (~L246, the `[entry for entry in raw_results if isinstance(entry, dict)]` pass-through) into
  four per-primitive normalizers (one per structured method), each mapping its wire insight result into
  the matching neutral row type from S1.
- Each `funnel` / `retention` / `trend` / `unique_count` method routes its wire result through its own
  normalizer; each **flattens** the nested/parallel-array insight structure to **one neutral row per
  data cell**, producing exactly its S1 row type — including COMPUTING `funnel.conversion_rate` as
  `count[i]/count[0]` (not a wire field; see Technical notes).
- **Thread the per-primitive normalizer through the shared `_run` / `_normalize_result` seam.** Today
  all five primitives call `self._run(query)` (~L393); `_run` reaches `_normalize_result` via **THREE**
  distinct completion sinks (verified against the code), and the row-builder must thread through ALL
  three or sync≠async:
  1. **immediate inline** — `_run` calls `_normalize_result(envelope, …)` directly (~L408) when the POST
     response carries no `query_status`.
  2. **already-complete-in-POST** — `_run` calls `_result_from_status(status)` DIRECTLY (~L404-405) when
     the POST response's `query_status` is already `complete` (the async-detection foot-gun path;
     `test_a_completed_status_in_the_post_response_does_not_poll` exercises it). This sink is easy to
     miss — it is NOT reached through the poll loop.
  3. **async-then-poll** — `_run` → `_poll_to_completion` (~L410) → `_result_from_status` (~L437) →
     `_normalize_result` on the nested `query_status` payload, once a poll returns `complete`.
  `_run` does NOT know which primitive it serves. To route per-primitive WITHOUT duplicating the poll
  plumbing, pass a per-primitive row-builder (a callable `(source: dict) -> list[Row]`, or a
  discriminator the shared normalizer switches on) DOWN through `_run` → `_poll_to_completion` →
  `_result_from_status` AND into `_run`'s direct `_result_from_status`/`_normalize_result` calls, so the
  SAME builder applies across all three sinks. Keep the shared envelope handling (the `raw_results` list
  guard, columns/generated_at/from_cache, the neutral "did not complete" error) in ONE place; only the
  ROW-building step becomes per-primitive. — ported from E15-S2 (architect, 2026-07-13).
- Keep the **columns-PRESENT** branch (the `raw_query` `_zip_row` cell-array zip) exactly as-is — those
  columns are the consumer's own SELECT projection and are already neutral.
- **`raw_query` keeps the CURRENT shared normalizer (both branches) unchanged** — it is the ONE
  primitive that is NOT per-primitive-flattened. Under the new routing, `raw_query`'s row-builder is
  exactly today's `_normalize_result` behavior (columns-present → `_zip_row`; columns-absent → the
  existing `isinstance(entry, dict)` object pass-through). Only the four structured primitives get
  flattening normalizers. The columns-absent OBJECT-passthrough behavior must survive FOR `raw_query`.
- All engine-internal keys (`breakdown_value`, `average_conversion_time`, `aggregation_value`,
  `converted_people_url`, …) are consumed INSIDE the normalizers and never appear on the returned rows.

### Out

- The type declarations — S1.
- Test inversion + fixtures — S3 (this story makes the code correct; S3 proves it).
- README — S4.
- Optional extras — deferred (epic Out of scope). Do NOT add `median_conversion_time` / `aggregated`.

## Acceptance criteria

- [ ] `funnel` / `retention` / `trend` / `unique_count` return rows in the neutral S1 shapes; no
      engine-internal key survives into a returned row.
- [ ] Each normalizer flattens to one row per data cell; the mapping is lossless on the real data
      values.
- [ ] `funnel.conversion_rate` is COMPUTED (`count[i]/count[0]`, guarded for `count[0] == 0` → `0`),
      not passed from a wire field; `funnel.event` resolves from `custom_name` / `name` / `action_id`
      (first present non-empty).
- [ ] `trend` / `unique_count` share ONE normalizer (identical wire shape); breakdown yields one
      row-series per breakdown-value entry.
- [ ] `raw_query` keeps the current shared normalizer (both branches) — its columns-present `_zip_row`
      AND its columns-absent object pass-through are behaviorally unchanged.
- [ ] Sync and async completion paths yield identical neutral rows for the same wire result (the
      per-primitive normalizer threads through both `_run` and `_result_from_status`).
- [ ] The poll/async PLUMBING stays correct (POST-then-GET sequencing, bounded give-up, `complete`-not-
      presence detection, error short-circuit) — those `test_http_query_adapter.py` poll tests keep their
      transport/URL/attempt assertions green. NOTE: `test_async_status_is_polled_until_complete_then_normalized`
      (`:289`) routes a columns-present cell-array through `trend`, so its RESULT-SHAPE assertion breaks
      under S2 — that break is an EXPECTED S3-owned inversion, NOT an S2 regression (S3 repoints it while
      keeping the poll assertions). `uv run mypy` · `uv run ruff check` green; neutrality-scan analog
      green. (Full `uv run pytest` green is S3's bar once it repoints the stale fixtures.)

## Technical notes

- **The wire insight shapes come from PostHog's server repo, NOT `posthog-python`** (which is a
  capture/flags SDK with no read side). They were ALREADY resolved by `posthog-source-guide` for E15
  and are pinned in the TS fixtures — the Python port reads to those pinned mappings, it does NOT
  re-resolve the wire. Build to these exact flatten mappings (identical to E15-S2, snake_case output):
  - **`trend` / `unique_count` → trend row `{ bucket, value, breakdown? }`.** Each wire `results` entry
    carries two POSITIONALLY-PARALLEL arrays: `days: str[]` (ISO bucket dates) and `data: number[]`
    (one value per bucket). Emit one row per index: `{ bucket: days[i], value: data[i] }`. When a
    breakdown was sent, PostHog returns ONE top-level `results` entry PER breakdown value, each with its
    own `days`/`data` plus a `breakdown_value` field — flatten each entry's buckets into rows and set
    `breakdown` from that entry's `breakdown_value` (stringified). `unique_count` is byte-identical on
    the wire — use the SAME normalizer, no branching (but its own named row concept from S1).
  - **`funnel` → funnel step row `{ step, event, count, conversion_rate, breakdown? }`.** Wire `results`
    is an array of per-step objects (an array-of-arrays when broken down — unwrap the outer layer per
    breakdown group). Each step object carries `order` (0-based step index), `count`, and
    `name` / `action_id` / `custom_name`. Map: `step` ← `order`; `event` ← first present non-empty of
    `custom_name`, else `name`, else `action_id`; `count` ← `count`. **`conversion_rate` is NOT a wire
    field — COMPUTE it** as `count[step] / count[0]` (guard `count[0] == 0` → `0`). When broken down,
    set `breakdown` from the group's `breakdown_value`.
  - **`retention` → retention row `{ cohort, period_index, value, breakdown? }`.** Wire `results` is an
    array of cohort objects, each with `date` (ISO cohort start) and `values: [{ count }]` — one cell
    per period, ARRAY INDEX is the period (index 0 = the cohort itself). Double loop: for each cohort,
    for each cell index `j` → `{ cohort: date, period_index: j, value: values[j].count }`. Set
    `breakdown` from the cohort's `breakdown_value` when present.
  — from E15-S2 (posthog-source-guide + architect, 2026-07-13), ported.
- **`converted_people_url` is NOT on this wire path** (legacy filter-based funnel surface, absent from
  the query-runner response). It trivially won't appear; the S3 seal test asserting its absence still
  holds. Do NOT map any `*_people_url` field.
- **`conversion_rate` field-name discipline + the ZeroDivisionError guard (locked, architect
  2026-07-13).** snake_case `conversion_rate` per `planning/QUERY-ROW-CONTRACT.md`. The derivation
  `count[i]/count[0]` is the library's own normalization responsibility — the wire never sends a rate.
  Do NOT pass a wire field through. **Guard `count[0] == 0 → 0.0` EXPLICITLY** — unlike JS, Python
  raises `ZeroDivisionError` on `x / 0` rather than yielding `Infinity`/`NaN`, so an unguarded divide
  crashes the normalizer (this is a genuine Python-vs-TS divergence, not just a `NaN` cosmetic; the TS
  guard was to avoid `NaN`/`Infinity`, the Python guard is to avoid a raised exception).
- **Row construction: use the direct dataclass + `QueryResult[...]` constructor, NOT `model_validate`
  (architect 2026-07-13).** Build each row by calling the frozen S1 dataclass constructor
  (`TrendRow(bucket=…, value=…, breakdown=…)`) and pass the list straight into
  `QueryResult[TrendRow](rows=[...], columns=[], generated_at=…, from_cache=…)`. Do NOT round-trip
  dataclass instances through `QueryResult.model_validate({...})` — the rows are already trusted-by-
  construction (built here, not decoded from wire), so constructing the generic `QueryResult` directly is
  correct and avoids re-validating already-parsed data.
- **Frozen dataclasses do NOT coerce — `value: float` accepts the wire int as-is.** The `*Row` types are
  `@dataclass(frozen=True)`, not Pydantic, so their field annotations are NOT runtime-enforced: a wire
  `data[i]` of `12` (int) passed to `TrendRow(value=…)` stores `12`, not `12.0`. This is fine — the
  neutral contract's numeric fields are documented `float`/`int` and Python `12 == 12.0`, so equality
  assertions and `model_dump_json()` both behave. Do NOT add a `float(...)` cast to "match" the
  annotation (it would be lossy churn and diverge from the TS fixture values, which are bare numbers).
  Keep the wire value's native type; only `conversion_rate` is a genuine computed `float` (a division
  result).
- **Defensive mapping.** PostHog types these result items as `Record[str, Any]` server-side; mirror the
  existing `isinstance` guard discipline in `_normalize_result` — coerce/skip a missing or wrong-typed
  cell rather than raising, so a malformed wire entry never crashes a snapshot job (the Python analog of
  E15-S2's defensive-map rule).
- **S1↔S2 seam.** The normalizers produce EXACTLY the S1 frozen-dataclass row types, field-for-field
  (`TrendRow`/`UniqueCountRow`/`FunnelStepRow`/`RetentionRow`). If S1 landed first, replace any temporary
  bridge cast S1 left in `_normalize_result`/the methods with the real flatten; if S1+S2 land together,
  the normalizer return types are the S1 types directly (no cast).
- The columns-absent branch is the ONLY leak; do NOT touch the columns-present `_zip_row`. — ported
  from E15-S2 (architect, 2026-07-13).
- **The four structured builders IGNORE `columns` entirely (E15-S2 reviewer note, ported).** A real
  trend/funnel/retention insight response carries NO `columns`/`types` on the wire, so the structured
  row-builders read only `raw_results` (`days`/`data`, `order`/`count`, `date`/`values`) and never zip by
  column. Do NOT let a structured builder fall back to `_zip_row` or key off `columns` — a fallback would
  reopen the leak (a spurious wire `columns` array would flatten `.rows` correctly but re-surface the
  engine column names on `result.columns`). Only `raw_query`'s builder consults `columns` (its unchanged
  columns-present zip). The structured `QueryResult[...]` is constructed with `columns=[]`.

> Reviewer suggestion (2026-07-13): `_first_step_count` is annotated `-> float` but its fallback
> returns the int literal `0` — harmless (`0 == 0.0`, feeds a division), cosmetic only; return `0.0`
> for symmetry with the `conversion_rate = 0.0` literal if touched.
> Reviewer suggestion (2026-07-13): funnel guards `count` as `int`-only while trend/retention allow
> `(int, float)` — deliberate and correct (`FunnelStepRow.count: int` per S1), but a silent divergence
> from TS's uniform `number`. S3's fixture stage could add a one-line note so a future reader doesn't
> "fix" it to accept float funnel counts.

## Shipped

> Captured by `implement-epics` on 2026-07-13.

- **Files changed:** `python/src/analytics_kit/query/http_adapter.py` (+243/-41) — split `_normalize_result`'s columns-absent branch into four flattening builders (`_build_trend_rows`/`_build_unique_count_rows`/`_build_funnel_rows`/`_build_retention_rows`); threaded a `RowBuilder[_TRow] | None` through all three completion sinks (`_run` inline, the direct already-complete-in-POST `_result_from_status`, and `_poll_to_completion` → `_result_from_status`); removed S1's four `# S1→S2 bridge` casts + comments; sealed the new insight wire keys into the `_WIRE_*` confinement.
- **Files added:** none
- **New public API:** none — behavior only (the seam types were S1). The four structured primitives now RETURN their neutral dataclass rows.
- **Tests added:** none — S3 owns test authoring. Builder positive-proved every mapping via a scratch run (deleted).
- **Commit:** `main` (message = story title)
- **Reviewer notes:** ship-ready, no critical, first review, faithful **parity with TS E15-S2**. Reviewer ran all six TS `query-contract.fixtures.ts` payloads through the Python builders → **byte-for-byte match** with the TS `expectedRows` (conversion_rate 1.0/0.62/0.41, per-group breakdown 1.0/0.5/1.0/0.25, retention period_index 0=cohort, event precedence `custom_name→name→action_id`). **Three-sink threading is GENUINE** — reviewer drove a real trend payload through each sink independently (poll POST→GET→`q-1/`, the direct already-complete-in-POST non-poll sink, immediate inline) → identical `TrendRow` output; the easy-to-miss direct `_result_from_status` carries the builder. `ZeroDivisionError` guard explicit (`0.0 if first==0`). raw_query byte-unchanged (`None`-builder path, both branches). Structured builders ignore `columns`, construct `columns=[]`. Direct dataclass constructor for structured rows; `model_validate` only for raw_query's wire boundary. `bool`-exclusion numeric guards are a Python-specific correctness improvement over TS. neutrality 0 violations; serialization seal confirms no engine key on any row. `http_adapter.py` mypy-clean.
- **THE key review call — 7 failing tests verified S3-owned inversions, NOT regressions.** Reviewer reproduced the builder's `git stash` counter-check (restoring S1's `http_adapter.py` makes all failing tests pass → they pin the OLD leak), and confirmed each feeds a columns-present cell-array through a structured primitive (impossible wire state → correct `[]`), failing ONLY on `.rows`/`.columns` while poll/transport/URL/error/neutrality assertions pass.
- **Retry history:** none — shipped first attempt.
- **Cross-story seams exposed:** Python pytest is 575/3-fail + quillstream 37/4-fail + 3+3 test-side mypy at S2 close — **S3 must clear ALL of it**: repoint the stale cell-array fixtures (`test_http_query_adapter.py:248`/`:289`, `test_real_stack_query_probe.py:129`, quillstream `test_query_exercise.py:135`/`:156`/`:171` + the 4 stale-fixture asserts) to realistic insight shapes; fix the `test_query_client.py:104` `_AltQueryClient` test-double Protocol pin; add/extend the row-level engine-key seal (`model_dump_json()`); add the per-primitive contract fixtures mirroring the TS values. After S3 the full Python + quillstream suites + mypy must be green.

## Follow-up

> Improvement pass (2026-07-13, commit `E16 improvement pass`).
- **`_first_step_count` return symmetry.** Its zero/fallback path now returns `0.0` (was the int literal `0`) to match the `conversion_rate = 0.0` literal — cosmetic, `0 == 0.0`, row output byte-identical. All gates green.
- (The separate `--full` neutrality fix — moving the port provenance from S2's builder docstrings to `#` comments — shipped as its own commit `a93ded3` BEFORE epic close, since it was a real artifact-scan gate failure rather than a nicety.)
