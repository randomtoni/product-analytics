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

- **Invert** the Python test that currently pins the columns-absent object pass-through as correct
  (the pytest analog of TS's `normalizeResult passes object entries through when columns are ABSENT` —
  locate in the Python query test suite by what it asserts: that `_normalize_result` on a columns-absent
  insight object passes engine objects through unchanged). It must now assert the wire insight object is
  **normalized into the neutral row type** for each structured primitive — asserting against the
  primitive-method output (or the per-primitive normalizer S2 exposes), not the old shared
  `_normalize_result` pass-through. `raw_query`'s columns-absent object pass-through stays pinned as
  correct (it is the ONE primitive that keeps it).
- **Extend the envelope-seal test** (the Python analog of TS's `the raw vendor envelope shape …
  appears NOWHERE in the returned value` — locate by the serialize-and-assert-absent shape) DOWN to the
  row level: assert the engine field names `breakdown_value`, `average_conversion_time`,
  `aggregation_value`, `converted_people_url` (and the trend-total near-homograph `aggregated_value`,
  per the E15-S3 improvement-pass note) appear NOWHERE in the serialized returned ROWS (serialize the
  full result — `model_dump`/`json` — not just the envelope keys). If there is a separate async-path
  seal test, extend it to the row level too so both sync and async paths are sealed at the row level.
- **Repoint any broken return-shape type-pins / assertions.** S1's return-type narrowing breaks any
  test asserting the old `QueryResult` return shape (a `mypy`-level pin or a runtime shape assertion).
  Repoint each to its narrowed row type; `raw_query` stays on the default. (The Python analog of E15-S3
  repointing the 8 `query-client.test.ts` pins — the exact count/location is whatever the Python suite
  actually has; locate by the assertions that break, do not invent.)
- Add **per-primitive wire-response fixtures** → asserted neutral-row output: one realistic wire insight
  response per structured primitive (`trend`, `unique_count`, `funnel`, `retention`), each with its
  expected neutral rows. **Mirror the TS fixture VALUES** in
  `ts/packages/node/src/query/query-contract.fixtures.ts` so cross-language parity is verifiable
  cell-for-cell. Cover the same cases E15-S3 required: trend breakdown (multi-entry `breakdown_value`);
  funnel array-of-arrays breakdown with per-group `conversion_rate`, the `count[0] == 0 → 0` guard, the
  `custom_name → name → action_id` precedence (empty-string skip); retention `period_index 0 = cohort`.
- Keep the new fixtures in the Python query test surface (a co-located `*fixtures*` module) so S4's
  cross-reference resolves to a stable path — the Python analog of `query-contract.fixtures.ts`.

### Out

- Type/adapter code — S1/S2 (this story only tests them; a revealed code gap is an S2 bug, not new
  scope here).
- README prose — S4. `planning/QUERY-ROW-CONTRACT.md` already exists; do NOT edit it.
- Optional extras — deferred (epic Out of scope).

## Acceptance criteria

- [ ] The former pass-through-pinning test asserts normalization into the neutral row type for the four
      structured primitives, not pass-through; `raw_query`'s object pass-through stays pinned as
      correct.
- [ ] The sync seal test AND (if present) the async seal test assert the engine field names
      (`breakdown_value`, `average_conversion_time`, `aggregation_value`, `aggregated_value`,
      `converted_people_url`) are absent from the serialized returned ROWS (not just the top-level
      envelope keys), against fixtures where those keys are GENUINELY present on the wire (non-vacuous),
      paired with a positive assertion the neutral key (`breakdown`) surfaced.
- [ ] Each of the four primitives has a wire-fixture → neutral-row assertion; breakdown covered for
      trend + funnel; the fixture VALUES mirror the TS `query-contract.fixtures.ts` values.
- [ ] Any broken return-shape pins are repointed to the narrowed row types; `raw_query` stays on the
      default; the suite typechecks green under `mypy`.
- [ ] Full `uv run pytest` green; `uv run ruff check` · `uv run mypy` green; neutrality-scan analog
      green.

## Technical notes

- **Mirror the TS fixture VALUES, don't re-derive them.** The executable form of the contract is
  `ts/packages/node/src/query/query-contract.fixtures.ts` (each fixture pairs a realistic backend
  `results` payload with the exact neutral rows the normalizer must produce). Port those SAME wire
  payloads + expected rows into the Python fixtures (snake_case expected keys), so a diff between the
  two languages' fixtures is the parity check. Do NOT invent independent Python fixture values — that
  would let the two trees silently drift.
- **`quillstream` example-consumer mocks — the E15-S3 fernly lesson.** Check
  `python/examples/quillstream/` for query-result mocks. Any that feed a columns-ABSENT insight shape
  into a STRUCTURED primitive model an impossible wire state (the fernly-snapshot bug E15-S3 hit — a
  HogQL-through-structured-primitive shape that never occurs) and must be repointed to the neutral
  rows. Columns-PRESENT (`raw_query`) mocks stay as-is (they exercise the unchanged `_zip_row` branch).
  If a columns-present mock goes red, something in S1/S2 wrongly touched the columns-present branch —
  that's an S2 bug, not an S3 fixture change.
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
