---
id: E16-S1-neutral-row-types
epic: E16-QRY-python-row-contract
status: ready-for-dev
area: query
touches: [node]
depends_on: []
api_impact: breaking
---

# E16-S1-neutral-row-types — Python neutral per-primitive row types + row-typed QueryResult

## Why

The Python read side has no row contract — the envelope is neutral but the rows are engine-keyed
dicts. This slice defines the four neutral row concepts and makes `QueryResult` carry its
per-primitive row type so the four primitives can narrow their return, establishing the contract the
normalizer (S2) fills. It mirrors TS E15-S1.

## Scope

### In

- Define the four neutral row concepts as **`frozen=True @dataclass`** types co-located with the
  query surface (`python/src/analytics_kit/query/client.py`), per the LOCKED
  `planning/QUERY-ROW-CONTRACT.md` snake_case field set (the type shape is RESOLVED — frozen
  dataclasses, NOT Pydantic, NOT `TypedDict`; see Technical notes for the full architect ruling):
  - `TrendRow` → `{ bucket: str; value: float; breakdown: str | None = None }`
  - `UniqueCountRow` → its OWN declared `@dataclass` with the same three fields as `TrendRow` — do
    NOT alias `UniqueCountRow = TrendRow` (the contract forbids collapsing it; an alias erases the
    named-concept identity)
  - `FunnelStepRow` → `{ step: int; event: str; count: int; conversion_rate: float; breakdown: str | None = None }`
  - `RetentionRow` → `{ cohort: str; period_index: int; value: float; breakdown: str | None = None }`
  - `breakdown` is a **defaulted `str | None = None`** field (present-as-null when the query was not
    broken down — the honest Python shape; do NOT try to reproduce TS's key-absence).
- Make `QueryResult` **`Generic[TRow]`** while it STAYS a Pydantic `BaseModel` (it decodes untrusted
  wire — a genuine boundary): `class QueryResult(BaseModel, Generic[TRow])` with `rows: Sequence[TRow]`
  (replacing today's `rows: list[dict[str, object]]`). The generic default rides a **PEP-696 `TypeVar`**
  — `TRow = TypeVar("TRow", default="Mapping[str, object]")` — imported from **`typing_extensions`**
  (the version gate is RESOLVED: `requires-python = ">=3.10"` < 3.13, so NOT `typing`). Add
  `typing_extensions` as an EXPLICIT `pyproject.toml` dependency (do not rely on the Pydantic
  transitive). **The `TypeVar` is UNBOUNDED — do NOT add `bound="Mapping[str, object]"`** (that is a
  DEFAULT, not a constraint; the four row types are frozen dataclasses, NOT `Mapping` subtypes, so a
  `Mapping` bound makes `mypy --strict` reject `QueryResult[TrendRow]` — story-refiner verified this
  against the repo toolchain, see Technical notes). `raw_query` keeps the default row type
  (`Mapping[str, object]`). See Technical notes for the fallback if PEP-696 defaults misbehave.
- Narrow `AnalyticsQueryClient`'s four structured method return types
  (`python/src/analytics_kit/query/client.py`, the Protocol ~L141): `funnel -> QueryResult[FunnelStepRow]`,
  `retention -> QueryResult[RetentionRow]`, `trend -> QueryResult[TrendRow]`,
  `unique_count -> QueryResult[UniqueCountRow]`; `raw_query -> QueryResult` (the default). This is a 1:1
  port of TS `query-client.ts`.
- Handle the generic-change RIPPLE (re-type only, NO logic change) so every `QueryResult` reference
  still typechecks under `mypy`. The sites are pinned:
  - `python/src/analytics_kit/query/noop.py` — narrow the five `QueryNoop` method return annotations to
    the matching `QueryResult[…Row]`. **`_empty_result` MUST become generic** — `def _empty_result() ->
    QueryResult[TRow]` (with a module-level `TRow = TypeVar("TRow")`), and each method just does
    `return _empty_result()` under its narrowed `-> QueryResult[TrendRow]` annotation — mypy infers
    `TRow=TrendRow` from the return context (do NOT try to subscript the call `_empty_result[TrendRow]()`
    — that is invalid Python; the inference is contextual, story-refiner verified it mypy-strict-green). **A BARE `_empty_result() ->
    QueryResult` does NOT typecheck into a narrowed return** — `mypy --strict` rejects
    `QueryResult[Mapping[str, object]]` → `QueryResult[TrendRow]` (story-refiner verified against the
    repo toolchain; the empty-list body is fine, but the RETURN ANNOTATION must be the generic
    `QueryResult[TRow]`, not a bare `QueryResult`). This is the exact Python analog of E15-S1's generic
    `emptyResult<TRow>()` no-cast fix. (`raw_query` narrows to the bare `QueryResult` default, so its
    call can stay `_empty_result()` inferring the `Mapping` default — or reuse the generic helper; both
    typecheck.)
  - `python/src/analytics_kit/query/warehouse_adapter.py` — the typed stub: narrow the five return
    annotations to match the Protocol; the bodies still `raise NotImplementedError` (a raise satisfies
    any narrowed return), keeping the second-adapter bar-A proof green.
  - `python/src/analytics_kit/query/http_adapter.py` — narrow the five method signatures to match the
    Protocol; the S1-scope change here is SIGNATURES only (`_normalize_result`'s BODY producing the
    rows is S2). S1 may leave the body producing the current dict rows behind a temporary cast /
    `type: ignore` bridge, or S1+S2 land together — builder's call (see Out).
  - `python/src/analytics_kit/query/factory.py` + `create_query_client` — follows the Protocol; no
    change beyond confirming it still typechecks against the narrowed `QueryNoop` / `HttpQueryAdapter`.
- Export the four row types from the query package surface
  (`python/src/analytics_kit/query/__init__.py` — add `TrendRow`, `UniqueCountRow`, `FunnelStepRow`,
  `RetentionRow` to the `from .client import (...)` block and `__all__`) AND re-export from the
  top-level package (`python/src/analytics_kit/__init__.py` — the query re-export block ~L42 + `__all__`
  ~L131), so the row types sit on the public surface consumers key on, mirroring TS's seam export.
- **Runtime caveat (pin, do not lose):** the generic narrowing is TYPING only — generics erase at
  runtime. Runtime neutrality comes from the frozen dataclass rows (an engine key can't be constructed
  onto a row) plus the S3 row-level seal test, NOT from the generic parameter.

### Out

- The normalizer changes that PRODUCE these rows — S2 (this story only declares types; the adapter may
  temporarily bridge until S2, or S1+S2 land together — builder's call).
- Optional extras (`median_conversion_time`, trend `aggregated`) — deferred (epic Out of scope).
- Docs + README — S4. `planning/QUERY-ROW-CONTRACT.md` already exists; do NOT edit it.
- Test-pin updates (any `pytest`/type-pin asserting the old return shape) — S3, unless S1+S2+S3 land
  together, in which case fix them then; treat a return-shape test break as an EXPECTED S3-owned
  inversion, not an S1 regression.

## Acceptance criteria

- [ ] The four neutral rows are each a `frozen=True @dataclass` (`TrendRow`, `UniqueCountRow`,
      `FunnelStepRow`, `RetentionRow`) with EXACTLY the snake_case fields from
      `planning/QUERY-ROW-CONTRACT.md` (`conversion_rate`, `period_index` snake_case); `breakdown` is a
      defaulted `str | None = None` field. NOT Pydantic models, NOT `TypedDict`.
- [ ] `UniqueCountRow` is its OWN declared `@dataclass` (same three fields as `TrendRow`), NOT an alias
      `UniqueCountRow = TrendRow`.
- [ ] `QueryResult` is a `Generic[TRow]` Pydantic `BaseModel` with `rows: Sequence[TRow]`; the `TRow`
      default rides an UNBOUNDED PEP-696 `TypeVar` (`default="Mapping[str, object]"`, NO `bound=`)
      imported from `typing_extensions`; `typing_extensions` is an EXPLICIT `pyproject.toml` dependency.
      `raw_query` stays on the default row type.
- [ ] The four structured primitives on `AnalyticsQueryClient` narrow their return
      (`funnel -> QueryResult[FunnelStepRow]`, etc.); `raw_query -> QueryResult` (default).
- [ ] No vendor/engine-internal field name appears in any row type.
- [ ] `QueryNoop` and `WarehouseQueryAdapter` narrow to match the Protocol, so both still satisfy
      `AnalyticsQueryClient` structurally (both bar-A/bar-B proofs stay green).
- [ ] The four row types are exported from `analytics_kit.query` AND the top-level `analytics_kit`
      package.
- [ ] `uv run mypy` · `uv run ruff check` green; the Python neutrality-scan analog green.

## Technical notes

- **Row-shape source of truth is `planning/QUERY-ROW-CONTRACT.md` (LOCKED).** snake_case field set per
  primitive; do not deviate. `conversion_rate` and `period_index` are snake_case; `bucket` / `value` /
  `breakdown` / `step` / `event` / `count` / `cohort` carry across unchanged.
- **RESOLVED — the Python generic-`QueryResult[TRow]` shape (architect 2026-07-13).** The one genuine
  design decision is settled; implement to this exactly, no further judgment needed:
  - **Each neutral row is a `frozen=True @dataclass`** — `TrendRow`, `UniqueCountRow`, `FunnelStepRow`,
    `RetentionRow`. NOT Pydantic models, NOT `TypedDict`. Rows are the adapter's OUTBOUND output (built
    from already-parsed wire), so the "Pydantic at boundaries" convention keeps them OFF Pydantic; the
    frozen dataclass constructor is the Python analog of TS's closed interface — an engine key can't be
    passed to the constructor (→ a construction error), which is the row-level neutrality proof.
  - **`UniqueCountRow` is its OWN declared `@dataclass`** with the same three fields as `TrendRow` —
    do NOT alias `UniqueCountRow = TrendRow` (the contract forbids collapsing it; an alias erases the
    named-concept identity). Same fields, distinct declared type.
  - **Field sets (snake_case):** `TrendRow` / `UniqueCountRow` = `{ bucket: str, value: <num>,
    breakdown: str | None = None }`; `FunnelStepRow` = `{ step: int, event: str, count: <num>,
    conversion_rate: float, breakdown: str | None = None }`; `RetentionRow` = `{ cohort: str,
    period_index: int, value: <num>, breakdown: str | None = None }`. `breakdown` is a defaulted
    `str | None = None` field (present-as-null when not broken down — the honest Python shape; do NOT
    try to reproduce TS key-absence).
  - **`QueryResult` STAYS a Pydantic `BaseModel`** (it decodes untrusted wire — `columns` / `from_cache`
    / `generated_at` — a genuine inbound boundary) and becomes **`Generic[TRow]`**:
    `class QueryResult(BaseModel, Generic[TRow])` with `rows: Sequence[TRow]` (replacing today's
    `rows: list[dict[str, object]]`). Pydantic v2 fully supports generic models AND stdlib-dataclass
    field types, and `model_dump_json()` recurses into the dataclass rows — the S3 seal test relies on
    this recursion.
  - **Generic default via a PEP-696 `TypeVar` — UNBOUNDED, default-only:**
    `TRow = TypeVar("TRow", default="Mapping[str, object]")`. **DO NOT add `bound="Mapping[str, object]"`.**
    The epic's original RESOLVED open question pinned a `bound=`; that was a **porting error** — TS's
    `QueryResult<TRow = Record<string, unknown>>` (`ts/packages/analytics-kit/src/query-result.ts:6`) puts
    `Record<string, unknown>` after the `=` with NO `extends` clause: it is a DEFAULT type argument on an
    UNBOUNDED parameter, not a constraint. Transcribing that default into Python's `bound=` slot is wrong:
    the four row types are frozen dataclasses (NOT `Mapping` subtypes), so a `Mapping` bound makes
    `mypy --strict` reject every structured narrowing with
    `Type argument "TrendRow" of "QueryResult" must be a subtype of "Mapping[str, object]" [type-var]`.
    **Story-refiner verified against the actual repo toolchain (pydantic 2.7.1, mypy --strict, python 3.10
    target, no pydantic mypy plugin):** default-only (no bound) is mypy-strict-green AND runtime-correct
    (construction + `model_dump_json()` recursion into the frozen dataclass rows all pass; `raw_query`'s
    bare `QueryResult` resolves `TRow` to the `Mapping[str, object]` default). The row-level neutrality
    proof is the frozen constructor + the S3 seal, NOT a type bound — the bound was doing no neutrality
    work in TS and must not be re-added here (architect confirmed 2026-07-13). **Version gate RESOLVED:**
    `python/pyproject.toml` `requires-python = ">=3.10"` (below 3.13), so import `TypeVar` from
    **`typing_extensions`**, NOT `typing`. `typing_extensions` is a Pydantic transitive dep, but add it as
    an EXPLICIT `pyproject.toml` dependency (do NOT rely on the transitive). **Fallback** if PEP-696
    defaults prove problematic under the toolchain: drop the default and annotate
    `raw_query -> QueryResult[Mapping[str, object]]` explicitly at the one call site (one extra
    annotation, same result) — prefer the default.
  - **Protocol narrowing:** the four structured methods narrow returns —
    `funnel -> QueryResult[FunnelStepRow]`, `retention -> QueryResult[RetentionRow]`,
    `trend -> QueryResult[TrendRow]`, `unique_count -> QueryResult[UniqueCountRow]`;
    `raw_query -> QueryResult` (default). 1:1 port of TS `query-client.ts`.
  - **Runtime caveat:** the generic narrowing is TYPING only (generics erase at runtime); runtime
    neutrality comes from the frozen dataclass rows + the S3 seal test, not the generic parameter.
  - **`extra="forbid"` note:** with rows as frozen dataclasses (not Pydantic), there is no per-row
    Pydantic model and thus no per-row `extra="forbid"`; the frozen constructor + S3 seal are the
    neutrality proof. `QueryResult`/`QueryColumn` keep their existing envelope-level `extra="forbid"`.
  — architect (2026-07-13).
- **Concrete import + construction shape in `client.py` (verified against the current file).** The file
  today imports `from dataclasses import dataclass` and `from typing import Literal, Protocol,
  runtime_checkable`. S1 adds: `from collections.abc import Mapping, Sequence`, `from typing import
  Generic`, and `from typing_extensions import TypeVar` (the `typing.TypeVar` already-in-scope, if any,
  must NOT shadow it — import the `typing_extensions` one under the name `TypeVar`). The rows use the CALL
  form `@dataclass(frozen=True)` (the bare `@dataclass` already imported is the non-frozen form the specs
  use — the rows need the `frozen=True` argument). `rows: Sequence[TRow]` replaces `rows:
  list[dict[str, object]]`; the `columns` / `generated_at` / `from_cache` fields and the envelope-level
  `model_config = ConfigDict(extra="forbid")` are UNCHANGED.
- **Existing `QueryResult(...)` constructions stay valid — the default TypeVar covers them.** The noop's
  `QueryResult(rows=[], columns=[], generated_at=…)` (`noop.py:28`) and the two bare constructions in
  `tests/test_query_client.py` (`:89`, `:231`) construct a bare `QueryResult` (= `QueryResult[Mapping[str,
  object]]` via the default) and still typecheck + run unchanged — story-refiner verified the default
  resolves. Only the NARROWED return annotations (the four structured methods + the noop's generic
  `_empty_result`) need the generic form. Any test asserting the OLD row SHAPE (dict-keyed rows out of a
  structured primitive) is an S3-owned inversion, not an S1 break — see S3.
- **The E15-S1 ripple precedent.** TS's "compiles unchanged" prediction for its example consumer was
  WRONG (interfaces carry no implicit index signature), forcing generic threading through
  `snapshots.ts`. Expect an analogous `quillstream` ripple in Python — check
  `python/examples/quillstream/` for `QueryResult`-typed snapshot code and thread it if the narrowing
  breaks it (do NOT launder it away with a blanket cast). Verify against the code before assuming it
  compiles unchanged.
- **Breaking:** consumers keying on the old engine-internal fields (`row["breakdown_value"]` etc.) will
  get `KeyError`/`None` after S2 lands. That is intended — the contract-establishing release. S1 only
  declares the types; the leak-closing is S2.

> Reviewer suggestion (2026-07-13): quillstream's `_assert_well_formed(result: QueryResult[_TRow])`
> introduces a free `_TRow` that never meaningfully binds (effectively `QueryResult[Any]` for the
> param) — fine for S1 (the call sites keep their narrowed rows), but S3, when it repoints the three
> stale `.rows == [{dict}]` assertions in that file, could tighten or drop the vestigial `_TRow`.
> Reviewer suggestion (2026-07-13): the four `# S1→S2 bridge` cast comments in `http_adapter.py` are
> load-bearing for the intermediate state but must be DELETED when S2 removes the casts — S2 should
> explicitly own "remove the four bridge casts + their comments" so the temporary signal doesn't ossify.

## Shipped

> Captured by `implement-epics` on 2026-07-13.

- **Files changed:** `python/src/analytics_kit/query/client.py` (four `frozen=True @dataclass` rows + generic `QueryResult(BaseModel, Generic[TRow])` with `rows: Sequence[TRow]` + unbounded PEP-696 `TRow` from `typing_extensions` + narrowed the four Protocol returns), `query/noop.py` (narrowed returns + generic `_empty_result() -> QueryResult[TRow]` no-cast fix), `query/warehouse_adapter.py` (narrowed stub returns), `query/http_adapter.py` (narrowed the five signatures; four `# S1→S2 bridge` casts wrap `_run` — `_normalize_result` BODY untouched), `query/__init__.py` + `src/analytics_kit/__init__.py` (export the four row types), `pyproject.toml` (added explicit `typing_extensions>=4.7` dep), `examples/quillstream/tests/test_query_exercise.py` (threaded the generic through `_assert_well_formed` — the E15 `snapshots.ts` ripple analog), + both `uv.lock` files (`uv sync` picked up the new dep).
- **Files added:** none
- **New public API:** `TrendRow`, `UniqueCountRow`, `FunnelStepRow`, `RetentionRow` + generic `QueryResult[TRow]` — exported from both `analytics_kit` and `analytics_kit.query`.
- **Tests added:** none — S1 is type-declaration + ripple; test authoring is S3. Full existing suite stays green (578 pass / 1 skip main; 41 pass quillstream).
- **Commit:** `main` (message = story title)
- **Reviewer notes:** ship-ready, no critical, first review, faithfully **parity with TS E15-S1** (Protocol narrowing 1:1 with `query-client.ts`; generic envelope mirrors `QueryResult<TRow = Record<string, unknown>>`). **Closedness is an executable neutrality proof** — reviewer confirmed at runtime that `TrendRow(..., aggregated_value=9)` raises `TypeError` and mutation raises `FrozenInstanceError`; no engine key anywhere in `client.py`. `UniqueCountRow` its own declared dataclass (`is TrendRow` → False) — *stronger* than the TS alias, per the contract's port note. TypeVar unbounded (grep-confirmed no `bound=`), `typing_extensions` explicit dep. Bridge cast signature-only (`_normalize_result` absent from diff). quillstream generic threading preserves the typed row (no laundering). `factory.py` needed zero edits (rides the Protocol structurally — a bar-B proof). Reviewer independently reproduced all gates.
- **Retry history:** none — shipped first attempt.
- **Cross-story seams exposed:** **S2 must remove the four `# S1→S2 bridge` casts + comments** in `http_adapter.py` by making `_normalize_result` construct the dataclass rows. **S3 owns 6 static-only mypy breaks** (all old dict-row-shape assertions): `tests/test_query_client.py:104` (the `_AltQueryClient` test-double returns bare `QueryResult`), `tests/test_http_query_adapter.py:248`/`:294`, quillstream `tests/test_query_exercise.py:135`/`:156`/`:171` — plus optionally tighten quillstream's vestigial `_TRow`. Every gate green except those 6; production `src/` fully mypy-green.

## Follow-up

> Improvement pass (2026-07-13, commit `E16 improvement pass`).
- **Vestigial quillstream `_TRow` dropped.** `test_query_exercise.py`'s `_assert_well_formed` helper is retyped `QueryResult[Any]` (the free `_TRow` TypeVar + its `typing_extensions` import removed) — the helper reads rows generically across all four primitives, mirroring the sibling `_assert_sealed` pattern. Type-only; no runtime change. All gates green (both suites, mypy 0, both neutrality modes).
