---
id: E16-S3-contract-tests-fixtures
epic: E16-QRY-python-row-contract
status: ready-for-dev
area: query
touches: [node]
depends_on: [E16-S2-per-primitive-normalizers]
api_impact: breaking
---

# E16-S3-contract-tests-fixtures — Invert the leak test, seal rows, add per-primitive fixtures (Python)

## Why

A pytest currently PINS the Python leak as correct pass-through — it must instead assert
normalization. This slice inverts that test, pushes the envelope-seal assertion down to the row level,
and adds wire→neutral-row fixtures that MIRROR the TS fixture values so cross-language parity is
executable, not just prose. It mirrors TS E15-S3.

## Scope

### In

- **REFRAME (story-refiner, verified against the real Python suite): there is NO pass-through-pinning
  test to invert — unlike TS.** The Python analog of TS's
  `normalizeResult passes object entries through when columns are ABSENT` is
  `test_columns_absent_rows_pass_through_as_records` (`tests/test_http_query_adapter.py:262`), but it
  calls `raw_query`, NOT a structured primitive — so it pins pass-through for `raw_query`, which STAYS
  correct under S2. **Do NOT invert it; leave it green.** Instead, the real work is to **repoint the
  stale "columns-present envelope through a STRUCTURED primitive" tests** (the impossible-wire-state
  fixtures — the Python analog of TS's stale cell-array-through-structured-primitive tests) and **add**
  positive normalization assertions. The tests that break under S2 (each routes a columns-PRESENT
  cell-array through a structured primitive and asserts dict-keyed rows — a wire state that never occurs
  for a structured insight; after S2 the primitive flattens `days`/`data`/`order`/`values`, so `.rows`
  no longer matches):
  - `tests/test_http_query_adapter.py:244` `test_immediate_envelope_normalizes_rows_keyed_by_column` —
    calls `funnel(...)` on `_immediate()` (`results:[[1,2]]`, `columns:["a","b"]`) and asserts
    `result.rows == [{"a": 1, "b": 2}]`. Repoint to `raw_query` (which keeps the column-zip) so the
    columns-present zip stays covered where it BELONGS, OR replace its fixture with a real funnel insight
    shape and assert `FunnelStepRow`s. Prefer repointing the column-zip coverage onto `raw_query` and
    adding a separate real-funnel-insight assertion.
  - `tests/test_http_query_adapter.py:289` `test_async_status_is_polled_until_complete_then_normalized`
    — calls `trend(...)`; the `_complete()` helper carries `results:[[9]]`, `columns:["n"]` and asserts
    `result.rows == [{"n": 9}]`. This test's PRIMARY job is the poll-until-complete plumbing (POST +
    two GETs), which must stay green — repoint only its result-shape assertion: either switch the call to
    `raw_query` (keeps the column-zip and the poll assertions) or give `_complete()` a real trend
    insight shape (`days`/`data`) and assert `TrendRow`s. Do NOT weaken the poll-count/URL assertions.
  Each inverted assertion must assert the wire insight is **normalized into the neutral row type** for
  its structured primitive, asserted against the primitive-method output. `raw_query`'s columns-absent
  object pass-through AND its columns-present zip stay pinned as correct (it is the ONE primitive that
  keeps both).
- **Add / extend the engine-field seal at the row level.** VERIFIED against the suite: there is NO
  existing test asserting the engine ROW field names are absent — the closest is
  `test_query_probe_body_carries_no_dollar_or_vendor_tokens_on_the_neutral_result`
  (`tests/test_real_stack_query_probe.py:156`), which serializes `result.model_dump_json().lower()` and
  asserts only `$` / `posthog` / `hogql` absent (a token-absence seal), and it feeds a **columns-present
  cell-array** canned response into `trend` (so its rows are dict-keyed today and will change under S2).
  So the "extend the seal DOWN to the row level" framing needs adjusting: **either add a NEW row-level
  seal test in `tests/test_http_query_adapter.py` (preferred — co-located with the per-primitive
  fixtures, driven by the injected `_CannedTransport`), or extend the existing
  `test_real_stack_query_probe.py` seal.** The row-level seal must: (a) feed each structured primitive a
  real insight fixture where the engine keys (`breakdown_value`, `average_conversion_time`,
  `aggregation_value`, `converted_people_url`, and the trend-total near-homograph `aggregated_value` per
  the E15-S3 improvement-pass note) are GENUINELY present on the wire (non-vacuous); (b) serialize the
  FULL result via `result.model_dump_json()` and assert each engine key appears NOWHERE in that string;
  (c) pair it with a positive assertion the neutral fields surfaced (including `"breakdown": null`
  present-null where not broken down, and the stringified breakdown label where broken down — see the
  seal-nuance note below). Because Python collapses sync+async into ONE blocking-poll method (no asyncio,
  no separate async test file), a single seal path covers both — but if you want sync≡async row-level
  coverage, drive the same fixture through the immediate branch AND the poll-to-complete branch (feed the
  insight shape inside a `query_status.complete` envelope) and assert identical sealed rows. Repoint the
  existing `test_real_stack_query_probe.py:156` seal's fixture to a real trend insight shape (`days`/
  `data`) so it too becomes a non-vacuous row-level seal rather than a columns-present cell-array.
- **Repoint the broken return-shape assertions — the enumerated real breaks (verified).** S1's
  narrowing is TYPING-only and runtime-erased, so under `mypy --strict` the `isinstance(result,
  QueryResult)` checks stay green (a narrowed `QueryResult[TrendRow]` is still a `QueryResult`). The
  breaks are RUNTIME row-SHAPE assertions that S2's flatten changes, NOT mypy pins (unlike TS's
  `expectTypeOf` pins — Python has no `expectTypeOf` in this suite). The tests that go red and must be
  repointed to the neutral rows (or moved onto `raw_query` where they were really covering the
  column-zip):
  - `tests/test_http_query_adapter.py:244`, `:289` — the two enumerated above.
  - `tests/test_real_stack_query_probe.py:119`
    `test_query_client_decodes_a_real_loopback_response_into_neutral_query_result` — calls `trend(...)`
    on the module-level columns-present `_CANNED_RESPONSE` (`results:[["2026-07-01",12],…]`,
    `columns:["day","count"]`) and asserts `result.rows == [{"day":…, "count":…}]` + `result.columns ==
    [QueryColumn(...)]`. After S2, `trend` reads `days`/`data`, not the cell-array/columns — this breaks.
    Repoint: give `_CANNED_RESPONSE` a real trend insight shape (`{"results":[{"days":[…],"data":[…]}]}`)
    and assert `TrendRow`s, OR switch this loopback test to `raw_query` (keeping the column-zip real-stack
    coverage it was actually exercising). Because `_CANNED_RESPONSE` is shared by the two other loopback
    tests (`:141` path/auth, `:156` seal), decide one shape for it and update all three consistently.
  - `tests/test_real_stack_query_probe.py:156` — the seal test (covered in the seal bullet above).
  - The quillstream example-consumer mocks (covered in the quillstream bullet below).
  `raw_query` assertions stay on the default `Mapping`-keyed rows.
  **`touches` note:** S3 now edits `tests/test_real_stack_query_probe.py` in addition to
  `tests/test_http_query_adapter.py` — both are the Python query test surface (`[node]`-analog).
- Add **per-primitive wire-response fixtures** → asserted neutral-row output: one realistic wire insight
  response per structured primitive (`trend`, `unique_count`, `funnel`, `retention`), each with its
  expected neutral rows. **Mirror the TS fixture VALUES** in
  `ts/packages/node/src/query/query-contract.fixtures.ts` so cross-language parity is verifiable
  cell-for-cell. Cover the same cases E15-S3 required: trend breakdown (multi-entry `breakdown_value`);
  funnel array-of-arrays breakdown with per-group `conversion_rate`, the `count[0] == 0 → 0` guard, the
  `custom_name → name → action_id` precedence (empty-string skip); retention `period_index 0 = cohort`.
- Keep the new fixtures in the Python query test surface as a co-located module
  **`tests/query_contract_fixtures.py`** (a non-`test_`-prefixed module under `tests/`, so pytest does
  NOT auto-collect it as a test but the test modules import it — the Python analog of
  `query-contract.fixtures.ts`), so S4's cross-reference resolves to a stable path. Structure it to
  mirror the TS file: one named fixture per case pairing the wire `results` payload with the expected
  neutral rows, plus an `ENGINE_ROW_FIELD_NAMES` list the seal test iterates. (If the repo's ruff/import
  conventions prefer fixtures under a `tests/query/` subdir or a `conftest`-adjacent module, the builder
  may relocate — but pin the final path in the Shipped notes so S4 can cite it exactly.)

### Out

- Type/adapter code — S1/S2 (this story only tests them; a revealed code gap is an S2 bug, not new
  scope here).
- README prose — S4. `planning/QUERY-ROW-CONTRACT.md` already exists; do NOT edit it.
- Optional extras — deferred (epic Out of scope).

## Acceptance criteria

- [ ] The stale columns-present-through-a-structured-primitive tests (`test_http_query_adapter.py:244`,
      `:289`; `test_real_stack_query_probe.py:119`) are repointed so each structured primitive asserts
      normalization into its neutral row type (or the column-zip coverage moved onto `raw_query`);
      `raw_query`'s object pass-through AND its columns-present zip stay pinned as correct
      (`test_columns_absent_rows_pass_through_as_records:262` stays green, NOT inverted).
- [ ] A row-level engine-field seal asserts the engine field names (`breakdown_value`,
      `average_conversion_time`, `aggregation_value`, `aggregated_value`, `converted_people_url`) are
      absent from the serialized returned ROWS (`result.model_dump_json()`, not just envelope keys),
      against fixtures where those keys are GENUINELY present on the wire (non-vacuous), paired with a
      positive assertion the neutral fields surfaced (including `"breakdown": null` present-null where
      not broken down). Both the immediate and poll-to-complete branches yield identically-sealed rows.
- [ ] Each of the four primitives has a wire-fixture → neutral-row assertion; breakdown covered for
      trend + funnel; the fixture VALUES mirror the TS `query-contract.fixtures.ts` values.
- [ ] Every runtime row-shape assertion broken by S2's flatten is repointed to the neutral rows (or
      moved onto `raw_query`); `raw_query` stays on the default; the full suite (incl.
      `test_real_stack_query_probe.py` and the quillstream query-exercise) is green under `pytest` and
      `mypy --strict`.
- [ ] Full `uv run pytest` green; `uv run ruff check` · `uv run mypy` green; neutrality-scan analog
      green.

## Technical notes

- **Mirror the TS fixture VALUES, don't re-derive them.** The executable form of the contract is
  `ts/packages/node/src/query/query-contract.fixtures.ts` (each fixture pairs a realistic backend
  `results` payload with the exact neutral rows the normalizer must produce). Port those SAME wire
  payloads + expected rows into the Python fixtures, so a diff between the two languages' fixtures is the
  parity check. Do NOT invent independent Python fixture values — that would let the two trees silently
  drift. **The exact TS exports to mirror (verified present in that file):** `trendSingleSeries`,
  `trendBreakdown`, `uniqueCountSingleSeries`, `funnelPlain`, `funnelZeroFirstStep`,
  `funnelEventPrecedence`, `funnelBreakdown`, `retentionCohorts`, and the `ENGINE_ROW_FIELD_NAMES` list
  (`breakdown_value`, `average_conversion_time`, `aggregation_value`, `aggregated_value`,
  `converted_people_url`). **Only two renames when porting expected rows to Python:** `conversionRate` →
  `conversion_rate`, `periodIndex` → `period_index`; the wire payload keys (`breakdown_value`, `days`,
  `data`, `order`, `values`, `date`, `custom_name`, `action_id`, …) are already snake_case / carry across
  unchanged. The wire `results` payloads copy VERBATIM. The funnel `conversion_rate` values
  (`0.62`/`0.41`/`0.5`/`0.25`/`0.2`, and `0` for the zero-first-step guard) are all exactly representable
  as Python floats — story-refiner verified `a/b == expected` holds for every fixture value, so plain
  `==` equality against the expected rows is safe (no `pytest.approx` needed).
- **`quillstream` example-consumer mocks — the E15-S3 fernly lesson (S3 OWNS this repoint, verified).**
  `python/examples/quillstream/tests/test_query_exercise.py` has a `_WIRE_BY_KIND` dict (~L32) that feeds
  **columns-PRESENT** cell-array fixtures (`{"columns":[…], "results":[[…]]}`) through the STRUCTURED
  primitives `funnel`/`retention`/`trend`/`unique_count` and asserts dict-keyed rows (e.g.
  `result.rows == [{"step":"workspace_created","count":1000}, …]` at `:131`, `{"period":0,"retained":500}`
  at `:152`, `{"day":…,"value":42}` at `:167`). This is the SAME impossible-wire-state bug E15-S3 hit in
  fernly: a structured primitive NEVER receives a columns-present cell-array — after S2 those methods
  flatten `days`/`data`/`order`/`values`, so all four `test_*_normalizes_to_a_flat_query_result` assertions
  break. **S3 OWNS repointing these** — swap `_WIRE_BY_KIND`'s structured entries for real insight shapes
  (funnel per-step objects, retention cohort objects, trend `days`/`data`) and repoint the assertions to
  the neutral rows. (E15-S3 took a scope-correction retry because it first said "leave fernly untouched";
  this story pre-authorizes the quillstream fix so no retry is needed.) `test_endpointless_config_is_the_query_footgun_no_op`
  (`:187`, the no-op path) and any `raw_query`/columns-present mock stay as-is. If a genuine `raw_query`
  columns-present mock goes red, something in S1/S2 wrongly touched the columns-present branch — that's an
  S2 bug, not an S3 fixture change.
  **`touches` note:** S3 edits `examples/quillstream/tests/test_query_exercise.py` too — pre-authorized
  scope, not a boundary crossing.
- **The seal technique — serialize via `model_dump_json()` (locked, architect 2026-07-13).** Extend the
  same serialize-and-assert-absent technique the existing envelope seal uses, but serialize the FULL
  result INCLUDING `rows` via `result.model_dump_json()` and assert the engine field names appear
  nowhere in that string. This works because `QueryResult` is a Pydantic `BaseModel` (S1) and Pydantic
  v2's `model_dump_json()` recurses into the frozen-dataclass rows — so a leaked engine key on a row
  would surface in the serialized output. Feed fixtures where those keys (`breakdown_value`, etc.) are
  genuinely on the WIRE so the seal is non-vacuous (the E15-S3 discipline: strengthen, don't weaken),
  paired with a positive assertion that the neutral `breakdown` field DID surface.
- **Seal-test nuance — assert on neutral FIELDS AND VALUES, not TS-style key-absence (architect
  2026-07-13).** The TS seal partly relied on key-ABSENCE (`breakdown?` omitted when not broken down).
  The Python row shape is different: `breakdown` is a defaulted `str | None = None` field, so it
  serializes as **present-null** (`"breakdown": null`) even when not broken down — that is the CORRECT,
  honest Python shape, NOT a leak. Do NOT assert `breakdown` is absent from the serialized output. The
  seal asserts the ENGINE keys are absent AND the neutral fields carry the expected VALUES (including
  `breakdown: null` where not broken down, and the stringified breakdown label where broken down). Assert
  field-and-value equality against the expected rows, not TS-style key presence/absence.
- **`touches` stays `[node]`** (the Python server target; the query surface lives in the node-analog
  package). Every file this story edits/adds lives in the Python query test surface.

## Shipped

<!-- Empty at draft. Filled by /implement-epics on close. -->
