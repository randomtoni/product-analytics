---
id: E16-QRY-python-row-contract
status: active
area: query
touches: [node, adapters]
api_impact: breaking
blocked_by: []
updated: 2026-07-13
---

# E16-QRY-python-row-contract — Python query read-side: port the neutral per-primitive row contract

## Why

The TS epic **E15-QRY-response-row-contract** shipped a neutral, documented per-primitive read-side
row contract and closed an **acceptance-bar-1 leak** where the HTTP query adapter passed
engine-internal insight keys (`breakdown_value`, `average_conversion_time`, `aggregation_value`, …)
through verbatim. E15 explicitly deferred the Python implementation to the Python query cycle and
wrote the **language-neutral shared contract** (`planning/QUERY-ROW-CONTRACT.md`) for it to port to.
This epic is that port: **the identical leak is live in Python today** —
`python/src/analytics_kit/query/http_adapter.py` `_normalize_result` has the same columns-absent
branch (`[entry for entry in raw_results if isinstance(entry, dict)]`) that forwards engine insight
objects as-is, and all four structured primitives (`funnel`/`retention`/`trend`/`unique_count`) route
through it. Parity rule (CLAUDE.md): every capability the TS surface exposes must be reachable in
Python. The row contract is now on the TS surface; Python is out of parity until this ships.

**This is a PORT, not a design.** The contract is LOCKED in `planning/QUERY-ROW-CONTRACT.md` — the
neutral field set per primitive and the Python snake_case casing are already decided. Do NOT
re-decide the shape.

## Success criteria

- The four structured primitives on `AnalyticsQueryClient` (Python) return **narrowed, documented
  neutral rows** — no engine-internal key survives into any returned row:
  - `trend` / `unique_count` → rows of `{ bucket, value, breakdown? }`
  - `funnel` → rows of `{ step, event, count, conversion_rate, breakdown? }` (snake_case `conversion_rate`)
  - `retention` → rows of `{ cohort, period_index, value, breakdown? }` (snake_case `period_index`)
- `raw_query` keeps the **verbatim column-keyed pass-through** (the consumer's own SELECT projection —
  the one place a dialect-keyed shape legitimately surfaces), documented as such.
- `unique_count` stays its **own named row concept** (same field set as the trend row) — the artifact
  explicitly forbids collapsing it into the trend row and losing the primitive's identity.
- **Cross-language parity, verifiable against `planning/QUERY-ROW-CONTRACT.md`:** the Python neutral
  rows are conceptually identical to the TS rows (same field concepts, snake_case casing), and the
  Python contract fixtures **mirror the TS fixture values** in
  `ts/packages/node/src/query/query-contract.fixtures.ts` so parity is executable, not just asserted
  in prose.
- **Bar A re-proven at the row level:** the neutral row contract is backend-agnostic — a SQL warehouse
  backend can populate the same rows from a `GROUP BY` with zero consumer change. Any Python consumer
  keying on the documented neutral fields survives a provider swap.
- **Bar B intact:** normalization is entirely adapter-internal; a new Python consumer wires the four
  primitives by config only, zero library change.
- The Python envelope-seal test extends **down to the row level**: the engine field names
  (`breakdown_value`, `average_conversion_time`, `aggregation_value`, `converted_people_url`) appear
  nowhere in the serialized returned rows.
- All Python gates green — `uv run pytest` · `uv run ruff check` · `uv run mypy` (from `python/`) —
  plus the Python neutrality-scan analog (`python/scripts/neutrality_scan.py`).

## Stories

- **[E16-S1](../stories/2-ready-for-dev/E16-S1-neutral-row-types.md)** *(breaking, no deps)* — four `frozen=True @dataclass` row concepts (`TrendRow`/`UniqueCountRow`/`FunnelStepRow`/`RetentionRow`) + make `QueryResult` a `Generic[TRow]` Pydantic `BaseModel` with `rows: Sequence[TRow]` (PEP-696 `TypeVar` default via `typing_extensions`, gate resolved); narrow the four Protocol returns, `raw_query` keeps the default; ripple across `noop.py`/`warehouse_adapter.py`/`factory.py`/`__init__.py` + top-level exports.
- **[E16-S2](../stories/2-ready-for-dev/E16-S2-per-primitive-normalizers.md)** *(breaking, depends on E16-S1)* — split `_normalize_result`'s columns-absent branch in `http_adapter.py` into four flattening normalizers constructing the S1 dataclass rows (trend/unique_count share one; funnel computes `conversion_rate`; retention double-loop), threaded through the sync `_run` + async `_result_from_status` seam; `raw_query` pass-through unchanged.
- **[E16-S3](../stories/2-ready-for-dev/E16-S3-contract-tests-fixtures.md)** *(breaking, depends on E16-S2)* — invert the pass-through-pinning pytest, extend the envelope-seal down to the row level (assert engine keys absent from `model_dump_json()`, present-null `breakdown` is correct), add per-primitive wire→neutral-row fixtures MIRRORING the TS `query-contract.fixtures.ts` values (trend breakdown, funnel array-of-arrays/zero-first-step/event-precedence, retention period_index 0 = cohort).
- **[E16-S4](../stories/2-ready-for-dev/E16-S4-contract-docs.md)** *(additive, depends on E16-S1; sequence after S3)* — state the per-primitive snake_case row shapes in the Python README query section; cross-reference the existing `planning/QUERY-ROW-CONTRACT.md` (do NOT rewrite it) + the S3 fixtures; confirm conceptual parity with the TS docs.

## Out of scope

- **Optional timing/total extras** — funnel median-conversion-time (`median_conversion_time`), a trend
  aggregated series total (`aggregated`). **Same deferral as E15:** these are additive (a new optional
  field on an existing row never breaks a consumer), so they need not ride this contract-establishing
  break. They land later as a non-breaking fast-follow in both trees together, once specced.
  `planning/QUERY-ROW-CONTRACT.md` already records them as a planned additive extension — leave room,
  do not implement.
- **Warehouse adapter SQL fill-in** — `warehouse_adapter.py` stays a typed stub (its methods narrow to
  the new return types and keep raising `NotImplementedError`); this epic only proves the row contract
  is backend-agnostic, it does not implement the SQL backend.
- **Growing the neutral query interface** beyond the four primitives + `raw_query` — anything else
  stays behind `raw_query`. We are firming the row shape of the existing primitives, not adding new
  ones.
- **The Python neutrality-scan analog itself** — it ALREADY EXISTS (`python/scripts/neutrality_scan.py`
  + `python/tests/test_neutrality_scan.py`, shipped in PY8). This epic uses it as a standing gate; it
  does not build it.
- **Rewriting `planning/QUERY-ROW-CONTRACT.md`** — the shared contract is the source of truth this
  epic ports TO. S4 cross-references it; it does not edit it (parity is by shared contract, not by
  re-authoring it per language).
- **Dashboards / charts / any visualization** — consumer territory.

## Notes

- **This is a parity port of a LOCKED contract.** The neutral field set and the Python snake_case
  casing are fixed by `planning/QUERY-ROW-CONTRACT.md` (`conversion_rate`, `period_index` are
  snake_case; `bucket`/`value`/`breakdown`/`step`/`event`/`count`/`cohort` carry across unchanged). Do
  not re-derive the shape — S1 declares exactly these; the story files must not deviate.
- **The leak is exactly the columns-absent branch** (verified against the code, `http_adapter.py`
  `_normalize_result` ~L246): columns-PRESENT → `_zip_row` (the `raw_query` cell-array zip — those
  columns are the consumer's own projection, and are FINE); columns-ABSENT →
  `[entry for entry in raw_results if isinstance(entry, dict)]` (the verbatim engine-object
  pass-through — the leak). Only the columns-absent branch is normalized per-primitive; the
  columns-present zip stays untouched. `raw_query` (~L361) keeps the current shared normalizer (both
  branches) unchanged — it is the ONE primitive that is NOT per-primitive-flattened.
- **The sync ≡ async seam mirrors E15's.** All five primitives call `_run` (~L393); `_run` calls
  `_normalize_result` on the inline envelope, and the async path (`_poll_to_completion` →
  `_result_from_status`, ~L410/L437) reuses the SAME `_normalize_result` on the completed
  `query_status` payload. S2 must thread the per-primitive normalizer through BOTH paths so a trend
  that arrives inline and one that arrives via poll yield identical neutral rows — exactly as E15
  threaded a row-builder through `run` → `pollToCompletion` → `resultFrom`.
- **The wire insight shapes come from PostHog's server repo, NOT `posthog-python`.** Like `posthog-js`,
  `posthog-python` is a capture/flags SDK with NO read side — it has none of these insight shapes. The
  authoritative wire field names + nesting were already resolved by `posthog-source-guide` for E15 and
  are pinned in `E15-S2` and in the TS fixtures. The Python port reads to those pinned mappings — it
  does NOT re-resolve the wire shape. The flatten mappings (build to these):
  - `trend` / `unique_count` → per wire `results` entry, positionally-parallel `days: str[]` +
    `data: number[]`; emit `{ bucket: days[i], value: data[i] }` per index; breakdown → one top-level
    `results` entry per breakdown value carrying its own `breakdown_value` (stringified onto
    `breakdown`). `unique_count` is byte-identical on the wire — SAME normalizer, no branching, but its
    OWN named row concept.
  - `funnel` → per-step objects (array-of-arrays when broken down, unwrap per group); `step` ← `order`;
    `event` ← first present non-empty of `custom_name` / `name` / `action_id`; `count` ← `count`;
    `conversion_rate` COMPUTED as `count[i]/count[0]` guarded to `0` when `count[0] == 0` (NOT a wire
    field); `breakdown` ← group `breakdown_value`.
  - `retention` → cohort objects, each `date` + `values: [{ count }]`; double loop, ARRAY INDEX is the
    period (`period_index 0` = the cohort itself); `{ cohort: date, period_index: j, value:
    values[j].count }`; `breakdown` ← cohort `breakdown_value`.
  - `converted_people_url` is NOT on this wire path (legacy filter-based funnel surface) — do not map
    any `*_people_url` field; the S3 seal test asserting its absence still holds trivially.
  — from E15-S2 (posthog-source-guide + architect, 2026-07-13), ported.
- **Defensive mapping discipline carries across.** PostHog types these result items as
  `Record<str, Any>` server-side; the Python normalizers mirror the existing `isinstance` guard
  discipline in `_normalize_result` — coerce/skip a missing or wrong-typed cell rather than raising, so
  a malformed wire entry never crashes a snapshot job.
- **Breaking → same framing as E15.** Python query-surface consumers keying on the old engine keys
  break; this is the contract-establishing release, breaking only fragile code that was already
  guessing at undocumented column names. **No compat shim** — a shim would re-leak the fields we are
  removing. The version bump is decided at cycle close on the cumulative API impact, not predicted
  here.
  - **Python packaging / version coordination — Open question for the user.** If the Python package
    versions independently of the TS packages, this is its own Python breaking bump. If Python ships
    from the same repo tag as TS (the polyglot monorepo may cut one coordinated tag), this break should
    land in the same tagged release as E15's TS break so the two trees stay at version parity. Confirm
    the Python versioning/tagging model before cycle close.
- **The known consumer.** `python/examples/quillstream/` is the Python example consumer (the Bar-B
  proof, the Python analog of fernly). Any query-result mocks there that feed columns-absent insight
  shapes into a structured primitive are stale-fixture inversions S3 must repoint (the exact
  fernly-snapshot-mock lesson from E15-S3 — those mocks modeled an impossible
  HogQL-through-structured-primitive shape). Columns-PRESENT (`raw_query`) mocks stay as-is.

### Open questions

- **RESOLVED (architect 2026-07-13) — the Python generic-`QueryResult[TRow]` shape.** The one genuine
  design decision is settled and baked into E16-S1's Technical notes. Summary: the four rows are each a
  **`frozen=True @dataclass`** (`TrendRow`/`UniqueCountRow`/`FunnelStepRow`/`RetentionRow`; `UniqueCountRow`
  is its OWN declared dataclass, NOT an alias) — outbound, trusted-by-construction, so they stay OFF
  Pydantic ("Pydantic at boundaries"); the frozen constructor is the Python analog of TS's closed
  interface (an engine key can't be passed → construction error). `QueryResult` **STAYS a Pydantic
  `BaseModel`** (it decodes untrusted wire — a genuine boundary) and becomes **`Generic[TRow]`** with
  `rows: Sequence[TRow]`; Pydantic v2 supports generic models + stdlib-dataclass field types, and
  `model_dump_json()` recurses into the dataclass rows (the S3 seal relies on this). Generic default via
  a PEP-696 `TypeVar` imported from **`typing_extensions`** (the version gate is RESOLVED — see below).
  Full ruling, field sets, and ripple sites are pinned in **E16-S1 Technical notes** — the builder needs
  no further judgment.
- **RESOLVED (architect 2026-07-13) — the version gate for PEP-696 `TypeVar` defaults.**
  `python/pyproject.toml` sets `requires-python = ">=3.10"` (below 3.13), so `TypeVar` with a `default=`
  must be imported from **`typing_extensions`**, NOT `typing`. `typing_extensions` is already a Pydantic
  transitive dep, but S1 adds it as an EXPLICIT `pyproject.toml` dependency (do not rely on a
  transitive). Fallback if PEP-696 defaults misbehave: drop the default and annotate
  `raw_query -> QueryResult[Mapping[str, object]]` explicitly (one extra annotation, same result) —
  prefer the default. Pinned in E16-S1 Technical notes.
- **The `extra="forbid"` neutrality-proof question is likewise resolved by the above.** With rows as
  frozen dataclasses (not Pydantic), the row-level neutrality proof is the frozen constructor (an engine
  key can't be constructed onto a row) PLUS the S3 row-level seal test (`model_dump_json()` carries no
  engine key). `QueryResult`/`QueryColumn` keep their existing `extra="forbid"` on the envelope. No
  per-row Pydantic model, so no per-row `extra="forbid"` — by design.

## Expansion path

The optional timing/total extras (`median_conversion_time`, trend `aggregated`) land as an additive
fast-follow — new optional fields on the existing rows, zero migration, in both trees together. A
future SQL warehouse backend populates the SAME neutral rows from a `GROUP BY`, proving the row
contract is backend-agnostic (bar A). Growth stays additive on the row types; `raw_query` remains the
only dialect-keyed surface. Parity with TS holds by shared contract (`planning/QUERY-ROW-CONTRACT.md`),
not shared code.
