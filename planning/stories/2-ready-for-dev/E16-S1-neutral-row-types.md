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
  — `TRow = TypeVar("TRow", bound="Mapping[str, object]", default="Mapping[str, object]")` — imported
  from **`typing_extensions`** (the version gate is RESOLVED: `requires-python = ">=3.10"` < 3.13, so
  NOT `typing`). Add `typing_extensions` as an EXPLICIT `pyproject.toml` dependency (do not rely on the
  Pydantic transitive). `raw_query` keeps the default row type (`Mapping[str, object]`). See Technical
  notes for the fallback if PEP-696 defaults misbehave.
- Narrow `AnalyticsQueryClient`'s four structured method return types
  (`python/src/analytics_kit/query/client.py`, the Protocol ~L141): `funnel -> QueryResult[FunnelStepRow]`,
  `retention -> QueryResult[RetentionRow]`, `trend -> QueryResult[TrendRow]`,
  `unique_count -> QueryResult[UniqueCountRow]`; `raw_query -> QueryResult` (the default). This is a 1:1
  port of TS `query-client.ts`.
- Handle the generic-change RIPPLE (re-type only, NO logic change) so every `QueryResult` reference
  still typechecks under `mypy`. The sites are pinned:
  - `python/src/analytics_kit/query/noop.py` — `_empty_result()` builds `rows=[]`; an empty list
    satisfies any `Sequence[TRow]`, so narrow the five `QueryNoop` method return annotations to the
    matching `QueryResult[…Row]` (and `_empty_result`'s return if the chosen shape requires it — an
    empty `QueryResult` constructor is assignable to any narrowed generic). This is the Python analog of
    E15-S1's generic `emptyResult<TRow>()`.
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
      default rides a PEP-696 `TypeVar` imported from `typing_extensions`; `typing_extensions` is an
      EXPLICIT `pyproject.toml` dependency. `raw_query` stays on the default row type.
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
  - **Generic default via a PEP-696 `TypeVar`:** `TRow = TypeVar("TRow", bound="Mapping[str, object]",
    default="Mapping[str, object]")`. **Version gate RESOLVED:** `python/pyproject.toml`
    `requires-python = ">=3.10"` (below 3.13), so import `TypeVar` from **`typing_extensions`**, NOT
    `typing`. `typing_extensions` is a Pydantic transitive dep, but add it as an EXPLICIT `pyproject.toml`
    dependency (do NOT rely on the transitive). **Fallback** if PEP-696 defaults prove problematic under
    the toolchain: drop the default and annotate `raw_query -> QueryResult[Mapping[str, object]]`
    explicitly (one extra annotation, same result) — prefer the default.
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
- **The E15-S1 ripple precedent.** TS's "compiles unchanged" prediction for its example consumer was
  WRONG (interfaces carry no implicit index signature), forcing generic threading through
  `snapshots.ts`. Expect an analogous `quillstream` ripple in Python — check
  `python/examples/quillstream/` for `QueryResult`-typed snapshot code and thread it if the narrowing
  breaks it (do NOT launder it away with a blanket cast). Verify against the code before assuming it
  compiles unchanged.
- **Breaking:** consumers keying on the old engine-internal fields (`row["breakdown_value"]` etc.) will
  get `KeyError`/`None` after S2 lands. That is intended — the contract-establishing release. S1 only
  declares the types; the leak-closing is S2.

## Shipped

<!-- Empty at draft. Filled by /implement-epics on close. -->
