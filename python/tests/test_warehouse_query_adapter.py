"""The warehouse query adapter — the bar-A proof made real.

This is the story's whole reason to exist: a SECOND query backend satisfies the SAME neutral
``AnalyticsQueryClient`` Protocol as the HTTP adapter, with ZERO change to the Protocol (bar A —
provider-swap is one adapter, zero consumer change). The consolidated conformance test feeds BOTH
adapters through the shipped ``_conforms`` type-level sink (mypy proves satisfaction without
subclassing), making "two adapters, one Protocol" explicit and co-located. Every primitive COMPUTES
— it generates SQL, routes it through the injected fake seam, and returns the same neutral rows the
HTTP adapter would, never a live connection.
"""

from __future__ import annotations

import inspect

import pytest
from db_execute_fakes import FakeDbExecute

from analytics_kit import (
    Duration,
    FunnelSpec,
    RetentionRow,
    RetentionSpec,
    TrendRow,
    TrendSpec,
    UniqueCountRow,
    UniqueCountSpec,
    define_taxonomy,
)
from analytics_kit.query import DbColumn, DbExecuteResult
from analytics_kit.query.http_adapter import HttpQueryAdapter
from analytics_kit.query.warehouse_adapter import (
    WarehouseQueryAdapter,
    create_warehouse_query_adapter,
)
from test_query_client import _conforms

# The injected DB-execute seam — the S3 reusable fake. In S4 the stub methods still raise before
# ever calling it; it only has to satisfy the required ``db_execute`` kwarg (E18 invokes it).
_FAKE_EXEC = FakeDbExecute()

# A taxonomy declaring the breakdown keys the SQL-gen guard checks against (E21-S5): `plan` and
# `o'brien` are declared event properties, so the typed view projects a column for each and a
# `breakdown="plan"`/`"o'brien"` query passes the declared-key guard. The non-breakdown tests keep
# the no-taxonomy `WarehouseQueryAdapter(db_execute=...)` form (their SQL never touches the set).
_BREAKDOWN_TAXONOMY = define_taxonomy(
    {
        "events": {
            "order_placed": {"amount": "number", "plan": "string", "o'brien": "string"},
            "signed_up": {},
        },
        "traits": {"plan": "string"},
    }
)


# --- bar A: two adapters, one Protocol, zero interface change ----------------------------


def test_warehouse_adapter_conforms_to_the_query_protocol_structurally() -> None:
    # The bar-A proof: the warehouse stub satisfies AnalyticsQueryClient by SHAPE alone — mypy
    # proves it at the _conforms sink, no subclassing, ZERO change to the PY5-S1 Protocol.
    adapter = WarehouseQueryAdapter(db_execute=_FAKE_EXEC)
    _conforms(adapter)
    from analytics_kit import AnalyticsQueryClient

    assert AnalyticsQueryClient not in type(adapter).__mro__


def test_both_query_adapters_satisfy_one_protocol_unchanged() -> None:
    # Consolidated bar A: the HTTP adapter AND the warehouse adapter — two independent shapes —
    # both pass through the same _conforms sink with zero interface change between them.
    http_adapter = HttpQueryAdapter(
        query_endpoint="https://query.example",
        personal_key="k",
        project_id="1",
    )
    warehouse_adapter = WarehouseQueryAdapter(db_execute=_FAKE_EXEC)
    _conforms(http_adapter)
    _conforms(warehouse_adapter)


# --- each primitive is a sync computing method -------------------------------------------


def test_every_primitive_is_sync_not_a_coroutine() -> None:
    # The sync def is load-bearing: an async def returns a coroutine (not QueryResult) and would
    # FAIL the _conforms sink — the bar-A proof depends on the sync signature.
    for member in ("funnel", "retention", "trend", "unique_count", "raw_query"):
        assert not inspect.iscoroutinefunction(getattr(WarehouseQueryAdapter, member))


def test_adapter_has_exactly_the_five_protocol_members() -> None:
    members = {name for name in dir(WarehouseQueryAdapter) if not name.startswith("_")}
    assert members == {"funnel", "retention", "trend", "unique_count", "raw_query"}


# --- the adapter REQUIRES an injected DbExecute; two-tier factory (DI + from-config) --------


def test_constructor_requires_a_db_execute() -> None:
    # The adapter's whole reason to exist post-S4 is to hold the injected seam — no "no exec"
    # state. A bare construction is a TypeError (missing required keyword-only argument).
    with pytest.raises(TypeError):
        WarehouseQueryAdapter()  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        create_warehouse_query_adapter()  # type: ignore[call-arg]


def test_from_config_builds_the_adapter_and_reads_the_dsn_at_the_boundary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The config-reading twin: it reads warehouse_dsn, builds the default driver from it, injects
    # it — proven here with the S3 fake at the driver-build boundary (no real Postgres/extra).
    import analytics_kit.query.warehouse_adapter as wh
    from analytics_kit import QueryClientConfig
    from analytics_kit.query.warehouse_adapter import create_warehouse_query_adapter_from_config

    seen: list[str] = []

    def _record(dsn: str) -> FakeDbExecute:
        seen.append(dsn)
        return _FAKE_EXEC

    monkeypatch.setattr(wh, "create_default_db_execute", _record)
    adapter = create_warehouse_query_adapter_from_config(
        QueryClientConfig(warehouse_dsn="postgresql://localhost/analytics")
    )

    assert isinstance(adapter, WarehouseQueryAdapter)
    assert seen == ["postgresql://localhost/analytics"]


def test_adapter_module_imports_without_the_warehouse_extra_installed() -> None:
    # Importing the adapter module must not import the driver (the lazy driver import stays at the
    # driver-build boundary). The dev env has no `warehouse` extra, so a clean import proves it.
    import analytics_kit.query.default_db_execute as dbx

    assert dbx._WAREHOUSE_DRIVER_AVAILABLE is False
    import analytics_kit.query.warehouse_adapter as wh  # noqa: F401 — the import itself is the assertion


# --- constructable + exported, but NOT the default selection ----------------------------


def test_create_warehouse_query_adapter_builds_the_adapter() -> None:
    adapter = create_warehouse_query_adapter(db_execute=_FAKE_EXEC)
    assert isinstance(adapter, WarehouseQueryAdapter)


def test_warehouse_adapter_is_not_selected_without_a_warehouse_dsn() -> None:
    # create_query_client selects the warehouse adapter ONLY when warehouse_dsn is present; an
    # unkeyed config is the no-op, a keyed+endpointed one is the HTTP adapter — neither warehouse.
    from analytics_kit import QueryClientConfig, QueryNoop, create_query_client

    assert isinstance(create_query_client(QueryClientConfig()), QueryNoop)
    http_client = create_query_client(
        QueryClientConfig(query_endpoint="https://q.example", personal_key="k")
    )
    assert not isinstance(http_client, WarehouseQueryAdapter)


# --- neutrality: named by role, no vendor / consumer-domain leak -------------------------


def test_adapter_and_export_are_named_by_role_not_vendor() -> None:
    # 'warehouse' is a role, not a vendor; the forbidden set is vendor/dialect tokens.
    assert WarehouseQueryAdapter.__name__ == "WarehouseQueryAdapter"
    assert create_warehouse_query_adapter.__name__ == "create_warehouse_query_adapter"
    surface = (
        WarehouseQueryAdapter.__name__ + " " + create_warehouse_query_adapter.__name__
    ).lower()
    assert "posthog" not in surface
    assert "hogql" not in surface


def test_documented_sql_mapping_names_no_consumer_event_or_domain() -> None:
    # The per-method SQL mapping is described generically against the typed view — it references
    # the spec fields (spec.steps, spec.window, ...), never a concrete consumer event/domain name.
    import analytics_kit.query.warehouse_adapter as warehouse

    doc = (warehouse.__doc__ or "").lower()
    assert "spec.steps" in doc
    assert "raw_query" in doc
    assert "typed view" in doc
    for leaked in ("signed_up", "activated", "pageview", "checkout"):
        assert leaked not in doc


# --- S1: trend + unique_count COMPUTE through the injected DbExecute seam --------------------

# A canned DbExecuteResult shaped like the warehouse SELECT: bucket/value cells + a driver-reported
# column schema. Single series (no breakdown column).
_TREND_SINGLE_RESULT = DbExecuteResult(
    columns=[DbColumn(name="bucket", type="text"), DbColumn(name="value", type="int8")],
    rows=[("2026-07-01", 12), ("2026-07-02", 30), ("2026-07-03", 7)],
)

# A breakdown result carries the extra breakdown cell per row.
_TREND_BREAKDOWN_RESULT = DbExecuteResult(
    columns=[DbColumn(name="bucket"), DbColumn(name="value"), DbColumn(name="breakdown")],
    rows=[
        ("2026-07-01", 8, "pro"),
        ("2026-07-02", 20, "pro"),
        ("2026-07-01", 4, "free"),
        ("2026-07-02", 10, "free"),
    ],
)


def test_trend_routes_sql_through_the_seam_and_returns_flat_trend_rows() -> None:
    fake = FakeDbExecute(_TREND_SINGLE_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    result = adapter.trend(TrendSpec(event="order_placed", aggregation="total", window=Duration(30, "day")))

    assert result.rows == [
        TrendRow(bucket="2026-07-01", value=12),
        TrendRow(bucket="2026-07-02", value=30),
        TrendRow(bucket="2026-07-03", value=7),
    ]
    # The event name is the ONE positional param; the SQL structure is inlined.
    assert len(fake.calls) == 1
    assert fake.calls[0].params == ["order_placed"]


def test_trend_sql_buckets_counts_filters_and_zero_fills() -> None:
    fake = FakeDbExecute(_TREND_SINGLE_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    adapter.trend(TrendSpec(event="order_placed", aggregation="total", window=Duration(30, "day")))

    sql = fake.calls[0].sql
    assert "date_trunc('day', timestamp)" in sql
    assert "count(*)" in sql
    assert "WHERE event = $1" in sql
    assert "generate_series" in sql
    assert "LEFT JOIN counts" in sql
    assert "coalesce(counts.value, 0)" in sql
    # day granularity → bare ISO date bucket label (no time component).
    assert "to_char(spine.bucket, 'YYYY-MM-DD')" in sql
    # never the base events table, never raw properties on the counting path.
    assert "FROM events_typed" in sql
    assert "FROM events\n" not in sql


def test_trend_unique_aggregation_uses_count_distinct() -> None:
    fake = FakeDbExecute(_TREND_SINGLE_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    adapter.trend(TrendSpec(event="order_placed", aggregation="unique", window=Duration(7, "day")))

    assert "count(distinct distinct_id)" in fake.calls[0].sql
    assert "count(*)" not in fake.calls[0].sql


def test_trend_hour_window_collapses_bucket_to_hour_with_time_label() -> None:
    fake = FakeDbExecute(_TREND_SINGLE_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    adapter.trend(TrendSpec(event="order_placed", aggregation="total", window=Duration(6, "hour")))

    sql = fake.calls[0].sql
    assert "date_trunc('hour', timestamp)" in sql
    assert 'to_char(spine.bucket, \'YYYY-MM-DD"T"HH24:00:00\')' in sql


def test_trend_breakdown_groups_by_typed_view_column_and_stringifies_breakdown_on_every_row() -> None:
    fake = FakeDbExecute(_TREND_BREAKDOWN_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake, taxonomy=_BREAKDOWN_TAXONOMY)

    result = adapter.trend(
        TrendSpec(event="order_placed", aggregation="total", window=Duration(30, "day"), breakdown="plan")
    )

    assert result.rows == [
        TrendRow(bucket="2026-07-01", value=8, breakdown="pro"),
        TrendRow(bucket="2026-07-02", value=20, breakdown="pro"),
        TrendRow(bucket="2026-07-01", value=4, breakdown="free"),
        TrendRow(bucket="2026-07-02", value=10, breakdown="free"),
    ]
    sql = fake.calls[0].sql
    assert '("plan")::text' in sql
    assert "GROUP BY date_trunc('day', timestamp), (\"plan\")::text" in sql
    assert "CROSS JOIN series" in sql
    # The breakdown path never reads raw properties.
    assert "properties ->>" not in sql


def test_trend_without_breakdown_emits_no_breakdown_column_and_rows_omit_breakdown() -> None:
    fake = FakeDbExecute(_TREND_SINGLE_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    result = adapter.trend(TrendSpec(event="order_placed", aggregation="total", window=Duration(30, "day")))

    assert "properties ->>" not in fake.calls[0].sql
    for row in result.rows:
        assert row.breakdown is None


def test_unique_count_always_counts_distinct_actors_and_returns_unique_count_rows() -> None:
    unique_result = DbExecuteResult(
        columns=[DbColumn(name="bucket"), DbColumn(name="value")],
        rows=[("2026-07-01", 140), ("2026-07-02", 165)],
    )
    fake = FakeDbExecute(unique_result)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    result = adapter.unique_count(UniqueCountSpec(event="order_placed", window=Duration(30, "day")))

    assert result.rows == [
        UniqueCountRow(bucket="2026-07-01", value=140),
        UniqueCountRow(bucket="2026-07-02", value=165),
    ]
    # unique_count keeps its own row identity even though the fields coincide with TrendRow.
    assert all(isinstance(row, UniqueCountRow) for row in result.rows)
    assert "count(distinct distinct_id)" in fake.calls[0].sql
    assert fake.calls[0].params == ["order_placed"]


def test_assembler_stamps_columns_from_the_driver_schema_stamps_generated_at_and_omits_from_cache() -> None:
    fake = FakeDbExecute(_TREND_SINGLE_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    result = adapter.trend(TrendSpec(event="order_placed", aggregation="total", window=Duration(30, "day")))

    # Unlike the HTTP structured path (forced columns=[]), the warehouse stamps the driver-reported
    # SELECT schema — the neutral column set, carrying `type` only when present.
    assert [(c.name, c.type) for c in result.columns] == [("bucket", "text"), ("value", "int8")]
    assert isinstance(result.generated_at, str) and result.generated_at
    # from_cache is omitted (defaulted None) — a live SQL exec has no cache envelope.
    assert result.from_cache is None


def test_empty_result_yields_empty_rows_never_a_raise() -> None:
    empty = DbExecuteResult(columns=[DbColumn(name="bucket"), DbColumn(name="value")], rows=[])
    fake = FakeDbExecute(empty)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    result = adapter.trend(TrendSpec(event="order_placed", aggregation="total", window=Duration(30, "day")))

    assert result.rows == []
    assert [(c.name, c.type) for c in result.columns] == [("bucket", None), ("value", None)]


def test_no_sql_column_name_or_engine_token_leaks_onto_a_returned_row() -> None:
    fake = FakeDbExecute(_TREND_BREAKDOWN_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake, taxonomy=_BREAKDOWN_TAXONOMY)

    result = adapter.trend(
        TrendSpec(event="order_placed", aggregation="total", window=Duration(30, "day"), breakdown="plan")
    )

    # The frozen TrendRow dataclass admits only bucket/value/breakdown — no extra key can attach.
    for row in result.rows:
        assert set(vars(row).keys()) == {"bucket", "value", "breakdown"}


def test_generated_sql_is_byte_identical_across_a_repeat_call() -> None:
    # Determinism: the same spec produces the same SQL string every time (no now()-dependent text
    # in the emitted SQL — now() is a SQL function call, not an interpolated timestamp).
    fake = FakeDbExecute(_TREND_SINGLE_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake)
    spec = TrendSpec(event="order_placed", aggregation="total", window=Duration(30, "day"))

    adapter.trend(spec)
    adapter.trend(spec)

    assert fake.calls[0].sql == fake.calls[1].sql


# The exact canonical SQL string for one trend case. This literal is MIRRORED byte-for-byte in the
# TS warehouse-sql test (`the generated trend SQL is byte-identical to the Python tree`) — the two
# assertions together pin cross-tree SQL parity: the Postgres string is language-agnostic, so any
# divergence between the trees trips one of the two mirrored literals.
_CANONICAL_TREND_SQL = (
    "WITH counts AS (\n"
    "  SELECT date_trunc('day', timestamp) AS bucket, count(*) AS value\n"
    "  FROM events_typed\n"
    "  WHERE event = $1 AND timestamp >= date_trunc('day', now() - interval '30 day')\n"
    "  GROUP BY date_trunc('day', timestamp)\n"
    ")\n"
    "SELECT to_char(spine.bucket, 'YYYY-MM-DD') AS bucket, coalesce(counts.value, 0) AS value\n"
    "FROM generate_series(date_trunc('day', now() - interval '30 day'), date_trunc('day', now()), interval '1 day') AS spine(bucket)\n"
    "  LEFT JOIN counts ON counts.bucket = spine.bucket\n"
    "ORDER BY spine.bucket"
)


def test_the_generated_trend_sql_matches_the_canonical_cross_tree_string() -> None:
    from analytics_kit.query.warehouse_sql import build_trend_sql

    query = build_trend_sql(TrendSpec(event="order_placed", aggregation="total", window=Duration(30, "day")))
    assert query.sql == _CANONICAL_TREND_SQL


# The sub-day (hour-granularity) canonical trend SQL. The `day` pin above only touches the
# pass-through row of BOTH interval/bucket tables (`day -> day` in each). This hourly case is the ONE
# that feeds the sub-day COLLAPSE row of both tables into a SINGLE query at once — the bucket grain
# (`date_trunc('hour', ...)` from `_BUCKET_UNIT_FOR_WINDOW_UNIT`) and the `generate_series` step
# keyword (`interval '1 hour'` from `_INTERVAL_KEYWORD_FOR_WINDOW_UNIT`) are both derived here. If a
# future edit desyncs the two tables (e.g. bumps one collapse target but not the other), the grain
# and the step diverge and this literal breaks — the standing gate against a latent parity trap.
# MIRRORED byte-for-byte in the TS warehouse adapter test.
_CANONICAL_TREND_SQL_HOURLY = (
    "WITH counts AS (\n"
    "  SELECT date_trunc('hour', timestamp) AS bucket, count(*) AS value\n"
    "  FROM events_typed\n"
    "  WHERE event = $1 AND timestamp >= date_trunc('hour', now() - interval '6 hour')\n"
    "  GROUP BY date_trunc('hour', timestamp)\n"
    ")\n"
    "SELECT to_char(spine.bucket, 'YYYY-MM-DD\"T\"HH24:00:00') AS bucket, coalesce(counts.value, 0) AS value\n"
    "FROM generate_series(date_trunc('hour', now() - interval '6 hour'), date_trunc('hour', now()), interval '1 hour') AS spine(bucket)\n"
    "  LEFT JOIN counts ON counts.bucket = spine.bucket\n"
    "ORDER BY spine.bucket"
)


def test_the_generated_hourly_trend_sql_matches_the_canonical_cross_tree_string() -> None:
    # The sub-day case that feeds both interval/bucket tables into one query — bucket grain + step
    # keyword must stay in step, or this literal breaks (the desync guard).
    from analytics_kit.query.warehouse_sql import build_trend_sql

    query = build_trend_sql(TrendSpec(event="order_placed", aggregation="total", window=Duration(6, "hour")))
    assert query.sql == _CANONICAL_TREND_SQL_HOURLY


def test_a_breakdown_key_with_an_embedded_single_quote_is_identifier_quoted() -> None:
    # The breakdown key is the ONE runtime consumer string that reaches the SQL text (everything else
    # is $1-bound or closed-enum-inlined). It now groups on the typed VIEW column via `_quote_ident`,
    # which double-quotes the identifier and doubles an embedded `"` — a single quote passes through
    # unchanged inside the identifier (distinct from the OLD JSONB-literal escaping, which doubled it).
    fake = FakeDbExecute(_TREND_SINGLE_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake, taxonomy=_BREAKDOWN_TAXONOMY)

    adapter.trend(
        TrendSpec(event="order_placed", aggregation="total", window=Duration(30, "day"), breakdown="o'brien")
    )

    assert "(\"o'brien\")::text" in fake.calls[0].sql
    assert "properties ->>" not in fake.calls[0].sql


# --- E21-S5: breakdown guards at SQL-gen time (undeclared key + no-taxonomy) -----------------


def test_an_undeclared_breakdown_key_raises_at_sql_gen_names_key_and_declarable_set() -> None:
    fake = FakeDbExecute(_TREND_SINGLE_RESULT)
    # A taxonomy WITH declared keys — but the breakdown names one that is not declared.
    adapter = WarehouseQueryAdapter(db_execute=fake, taxonomy=_BREAKDOWN_TAXONOMY)

    with pytest.raises(ValueError, match=r'breakdown key "undeclared_key" is not a declared event property'):
        adapter.trend(
            TrendSpec(
                event="order_placed",
                aggregation="total",
                window=Duration(30, "day"),
                breakdown="undeclared_key",
            )
        )
    # No SQL was emitted — the guard fires before the DB-execute seam is ever called.
    assert fake.calls == []


def test_an_undeclared_key_error_lists_the_declarable_keys_sorted() -> None:
    fake = FakeDbExecute(_TREND_SINGLE_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake, taxonomy=_BREAKDOWN_TAXONOMY)

    # sorted union of order_placed's declared keys: amount, o'brien, plan.
    with pytest.raises(ValueError, match=r"declarable keys are: amount, o'brien, plan"):
        adapter.trend(
            TrendSpec(event="order_placed", aggregation="total", window=Duration(30, "day"), breakdown="pln")
        )
    assert fake.calls == []


def test_a_breakdown_query_with_no_taxonomy_raises_a_distinct_missing_taxonomy_config_error() -> None:
    fake = FakeDbExecute(_TREND_BREAKDOWN_RESULT)
    # No taxonomy supplied — a breakdown must raise the missing-taxonomy config error (naming the fix),
    # NOT the generic undeclared-key error.
    adapter = WarehouseQueryAdapter(db_execute=fake)

    with pytest.raises(
        ValueError,
        match=r"a warehouse breakdown query requires a taxonomy on QueryClientConfig",
    ):
        adapter.trend(
            TrendSpec(event="order_placed", aggregation="total", window=Duration(30, "day"), breakdown="plan")
        )
    assert fake.calls == []


def test_warehouse_result_omits_from_cache_matching_the_ts_absent_key() -> None:
    # Cross-tree parity: a live SQL exec has no cache envelope. The TS tree omits the optional
    # `fromCache` key entirely; the Python tree leaves `from_cache` at its `None` default. Pin that
    # the field is None so the two trees are observably identical on the cache flag.
    fake = FakeDbExecute(_TREND_SINGLE_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    result = adapter.trend(TrendSpec(event="order_placed", aggregation="total", window=Duration(30, "day")))

    assert result.from_cache is None
    # And it is not spuriously serialized as a set value when the model is dumped by field-set.
    assert "from_cache" not in result.model_dump(exclude_none=True)


# --- S2: funnel COMPUTES through the injected DbExecute seam ---------------------------------

# The funnel SQL returns N rows (one per step): (step_index, event_name, actor_count). Each
# adversarial scenario is driven by handing the fake the step-count rows THAT scenario's SQL would
# return — the SQL's ordering/window/boundary logic is what produces those counts; the adapter +
# flat-row builder are what this suite exercises directly (SQL shape is asserted separately).

from analytics_kit import FunnelStepRow  # noqa: E402 — grouped with the S2 block it belongs to

_TWO_STEP_FUNNEL_SPEC = FunnelSpec(steps=["signed_up", "order_placed"], within=Duration(7, "day"))

# step-0 count 1000, step-1 count 620 → conversion_rate 1, 0.62 (matches funnel_plain contract).
_FUNNEL_PLAIN_RESULT = DbExecuteResult(
    columns=[
        DbColumn(name="step_index", type="int4"),
        DbColumn(name="event_name", type="text"),
        DbColumn(name="actor_count", type="int8"),
    ],
    rows=[(0, "signed_up", 1000), (1, "order_placed", 620)],
)


def test_funnel_computes_routes_sql_through_seam_returns_rows_with_spec_event_and_computed_rate() -> None:
    fake = FakeDbExecute(_FUNNEL_PLAIN_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    result = adapter.funnel(_TWO_STEP_FUNNEL_SPEC)

    assert result.rows == [
        FunnelStepRow(step=0, event="signed_up", count=1000, conversion_rate=1.0),
        FunnelStepRow(step=1, event="order_placed", count=620, conversion_rate=0.62),
    ]
    # Each step's event name is a positional param, in step order.
    assert len(fake.calls) == 1
    assert fake.calls[0].params == ["signed_up", "order_placed"]


def test_funnel_makes_one_db_execute_call_with_a_single_statement() -> None:
    fake = FakeDbExecute(_FUNNEL_PLAIN_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    adapter.funnel(
        FunnelSpec(steps=["signed_up", "order_placed", "document_uploaded"], within=Duration(7, "day"))
    )

    assert len(fake.calls) == 1
    # A single statement — no semicolon-joined batch of per-step queries.
    assert len([s for s in fake.calls[0].sql.split(";") if s.strip()]) == 1


def test_funnel_sql_anchors_t0_enforces_strict_ordering_inclusive_window_distinct_counts() -> None:
    fake = FakeDbExecute(_FUNNEL_PLAIN_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    adapter.funnel(_TWO_STEP_FUNNEL_SPEC)

    sql = fake.calls[0].sql
    # t0 anchored at the step-0 event's earliest timestamp per actor.
    assert "min(timestamp) AS t0" in sql
    assert "FROM matched WHERE step_index = 0" in sql
    # Strict step-to-step ordering: the next step must be STRICTLY after the prior reached_at.
    assert "m.timestamp > w.reached_at" in sql
    # Window measured from step 0 and INCLUSIVE upper bound (closed [t0, t0 + within], `<=`).
    assert "m.timestamp <= w.t0 + interval '7 day'" in sql
    # Distinct-actor counts (assert the intended shape positively — funnel legitimately uses
    # count(distinct …), so no negative `count(*)` assertion).
    assert "count(DISTINCT w.distinct_id) AS actor_count" in sql
    # Single recursive statement over the typed view, never the base events table.
    assert "WITH RECURSIVE" in sql
    assert "FROM events_typed e" in sql
    assert "FROM events\n" not in sql
    # Steps bound as positional params (never inlined event literals).
    assert "VALUES (0, $1), (1, $2)" in sql


def test_funnel_sql_is_structurally_constant_across_step_count() -> None:
    fake = FakeDbExecute(_FUNNEL_PLAIN_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    adapter.funnel(FunnelSpec(steps=["a", "b"], within=Duration(7, "day")))
    adapter.funnel(FunnelSpec(steps=["a", "b", "c"], within=Duration(7, "day")))

    two_step = fake.calls[0].sql
    three_step = fake.calls[1].sql
    # The step count only shifts the VALUES rows and the `< N` recursion bound; the CTE body is
    # otherwise byte-identical between arities.
    assert "VALUES (0, $1), (1, $2)" in two_step
    assert "WHERE w.step_index + 1 < 2" in two_step
    assert "VALUES (0, $1), (1, $2), (2, $3)" in three_step
    assert "WHERE w.step_index + 1 < 3" in three_step
    # The recursive-term chase line is identical regardless of arity.
    assert "    (SELECT min(m.timestamp) FROM matched m" in two_step
    assert "    (SELECT min(m.timestamp) FROM matched m" in three_step


def test_funnel_adversarial_out_of_order_does_not_count_toward_the_funnel() -> None:
    # An actor firing step 2's event before step 1's does NOT complete the funnel. The SQL's strict
    # `m.timestamp > w.reached_at` clause excludes them; the fake returns the counts that SQL would
    # produce — 1000 reached step 0, only 400 completed step 1 in order.
    out_of_order = DbExecuteResult(
        columns=[DbColumn(name="step_index"), DbColumn(name="event_name"), DbColumn(name="actor_count")],
        rows=[(0, "signed_up", 1000), (1, "order_placed", 400)],
    )
    fake = FakeDbExecute(out_of_order)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    result = adapter.funnel(_TWO_STEP_FUNNEL_SPEC)

    assert result.rows == [
        FunnelStepRow(step=0, event="signed_up", count=1000, conversion_rate=1.0),
        FunnelStepRow(step=1, event="order_placed", count=400, conversion_rate=0.4),
    ]
    assert "m.timestamp > w.reached_at" in fake.calls[0].sql


def test_funnel_adversarial_boundary_completion_exactly_at_t0_plus_within_counts() -> None:
    at_boundary = DbExecuteResult(
        columns=[DbColumn(name="step_index"), DbColumn(name="event_name"), DbColumn(name="actor_count")],
        rows=[(0, "signed_up", 10), (1, "order_placed", 10)],
    )
    fake = FakeDbExecute(at_boundary)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    result = adapter.funnel(_TWO_STEP_FUNNEL_SPEC)

    assert result.rows[1] == FunnelStepRow(step=1, event="order_placed", count=10, conversion_rate=1.0)
    # The upper bound is the closed interval `<=` (INCLUSIVE), not `<`.
    assert "m.timestamp <= w.t0 + interval '7 day'" in fake.calls[0].sql
    assert "m.timestamp < w.t0 + interval '7 day'" not in fake.calls[0].sql


def test_funnel_adversarial_boundary_completion_one_tick_past_does_not_count() -> None:
    one_tick_past = DbExecuteResult(
        columns=[DbColumn(name="step_index"), DbColumn(name="event_name"), DbColumn(name="actor_count")],
        rows=[(0, "signed_up", 10), (1, "order_placed", 9)],
    )
    fake = FakeDbExecute(one_tick_past)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    result = adapter.funnel(_TWO_STEP_FUNNEL_SPEC)

    # The one actor whose step 1 landed a tick past the window is excluded: 9, not 10.
    assert result.rows[1] == FunnelStepRow(step=1, event="order_placed", count=9, conversion_rate=0.9)


def test_funnel_adversarial_partial_completion_counts_toward_step_1_and_stays_non_increasing() -> None:
    partial = DbExecuteResult(
        columns=[DbColumn(name="step_index"), DbColumn(name="event_name"), DbColumn(name="actor_count")],
        rows=[(0, "signed_up", 1000), (1, "order_placed", 620), (2, "document_uploaded", 410)],
    )
    fake = FakeDbExecute(partial)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    result = adapter.funnel(
        FunnelSpec(steps=["signed_up", "order_placed", "document_uploaded"], within=Duration(7, "day"))
    )

    assert result.rows == [
        FunnelStepRow(step=0, event="signed_up", count=1000, conversion_rate=1.0),
        FunnelStepRow(step=1, event="order_placed", count=620, conversion_rate=0.62),
        FunnelStepRow(step=2, event="document_uploaded", count=410, conversion_rate=0.41),
    ]
    # Per-step monotonic non-increase holds.
    counts = [row.count for row in result.rows]
    assert all(counts[i] <= counts[i - 1] for i in range(1, len(counts)))


def test_funnel_conversion_rate_guard_zero_first_step_yields_zero_on_every_step() -> None:
    zero_first = DbExecuteResult(
        columns=[DbColumn(name="step_index"), DbColumn(name="event_name"), DbColumn(name="actor_count")],
        rows=[(0, "signed_up", 0), (1, "order_placed", 0)],
    )
    fake = FakeDbExecute(zero_first)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    result = adapter.funnel(_TWO_STEP_FUNNEL_SPEC)

    assert result.rows == [
        FunnelStepRow(step=0, event="signed_up", count=0, conversion_rate=0.0),
        FunnelStepRow(step=1, event="order_placed", count=0, conversion_rate=0.0),
    ]
    # No NaN/inf leaked through the guard.
    import math

    for row in result.rows:
        assert math.isfinite(row.conversion_rate)


def test_funnel_conversion_rate_normal_ratios_are_count_step_over_count_zero() -> None:
    fake = FakeDbExecute(_FUNNEL_PLAIN_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    result = adapter.funnel(_TWO_STEP_FUNNEL_SPEC)

    assert result.rows[0].conversion_rate == 1.0
    assert result.rows[1].conversion_rate == pytest.approx(0.62)


def test_funnel_with_a_breakdown_per_group_rate_breakdown_on_every_row_typed_view_group_by() -> None:
    breakdown_result = DbExecuteResult(
        columns=[
            DbColumn(name="step_index"),
            DbColumn(name="event_name"),
            DbColumn(name="breakdown"),
            DbColumn(name="actor_count"),
        ],
        rows=[
            (0, "signed_up", "pro", 800),
            (1, "order_placed", "pro", 400),
            (0, "signed_up", "free", 200),
            (1, "order_placed", "free", 50),
        ],
    )
    fake = FakeDbExecute(breakdown_result)
    adapter = WarehouseQueryAdapter(db_execute=fake, taxonomy=_BREAKDOWN_TAXONOMY)

    result = adapter.funnel(
        FunnelSpec(steps=["signed_up", "order_placed"], within=Duration(7, "day"), breakdown="plan")
    )

    assert result.rows == [
        FunnelStepRow(step=0, event="signed_up", count=800, conversion_rate=1.0, breakdown="pro"),
        FunnelStepRow(step=1, event="order_placed", count=400, conversion_rate=0.5, breakdown="pro"),
        FunnelStepRow(step=0, event="signed_up", count=200, conversion_rate=1.0, breakdown="free"),
        FunnelStepRow(step=1, event="order_placed", count=50, conversion_rate=0.25, breakdown="free"),
    ]
    sql = fake.calls[0].sql
    assert '("plan")::text AS bd' in sql
    assert "GROUP BY s.step_index, s.event_name, w.bd" in sql
    # The breakdown value is anchored at each actor's step-0 event (one bucket per actor).
    assert "(array_agg(bd ORDER BY timestamp))[1] AS bd" in sql
    assert "properties ->>" not in sql


def test_funnel_rows_carry_no_engine_wire_field() -> None:
    fake = FakeDbExecute(_FUNNEL_PLAIN_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    result = adapter.funnel(_TWO_STEP_FUNNEL_SPEC)

    # The frozen FunnelStepRow dataclass admits only step/event/count/conversion_rate/breakdown —
    # no engine wire field can attach.
    for row in result.rows:
        assert set(vars(row).keys()) == {"step", "event", "count", "conversion_rate", "breakdown"}
        for engine_field in ("average_conversion_time", "converted_people_url", "breakdown_value"):
            assert not hasattr(row, engine_field)


# The exact canonical funnel SQL string for the plain two-step case. MIRRORED byte-for-byte in the
# TS warehouse adapter test — the two assertions together pin cross-tree funnel SQL parity.
_CANONICAL_FUNNEL_SQL = (
    "WITH RECURSIVE steps(step_index, event_name) AS (\n"
    "  VALUES (0, $1), (1, $2)\n"
    "),\n"
    "matched AS (\n"
    "  SELECT e.distinct_id, s.step_index, e.timestamp\n"
    "  FROM events_typed e\n"
    "  JOIN steps s ON e.event = s.event_name\n"
    "),\n"
    "anchor AS (\n"
    "  SELECT distinct_id, min(timestamp) AS t0\n"
    "  FROM matched WHERE step_index = 0\n"
    "  GROUP BY distinct_id\n"
    "),\n"
    "walk AS (\n"
    "  SELECT a.distinct_id, 0 AS step_index, a.t0 AS reached_at, a.t0\n"
    "  FROM anchor a\n"
    "  UNION ALL\n"
    "  SELECT w.distinct_id, w.step_index + 1,\n"
    "    (SELECT min(m.timestamp) FROM matched m\n"
    "      WHERE m.distinct_id = w.distinct_id AND m.step_index = w.step_index + 1 AND m.timestamp > w.reached_at AND m.timestamp <= w.t0 + interval '7 day'),\n"
    "    w.t0\n"
    "  FROM walk w\n"
    "  WHERE w.step_index + 1 < 2\n"
    "    AND EXISTS (SELECT 1 FROM matched m\n"
    "      WHERE m.distinct_id = w.distinct_id AND m.step_index = w.step_index + 1 AND m.timestamp > w.reached_at AND m.timestamp <= w.t0 + interval '7 day')\n"
    ")\n"
    "SELECT s.step_index, s.event_name, count(DISTINCT w.distinct_id) AS actor_count\n"
    "FROM steps s\n"
    "  LEFT JOIN walk w ON w.step_index = s.step_index AND w.reached_at IS NOT NULL\n"
    "GROUP BY s.step_index, s.event_name\n"
    "ORDER BY s.step_index"
)


def test_the_generated_funnel_sql_matches_the_canonical_cross_tree_string() -> None:
    from analytics_kit.query.warehouse_sql import build_funnel_sql

    query = build_funnel_sql(_TWO_STEP_FUNNEL_SPEC)
    assert query.sql == _CANONICAL_FUNNEL_SQL


# --- S3: retention COMPUTES through the injected DbExecute seam ------------------------------

# The retention SQL returns one row per DENSE (cohort, period_index) cell:
# (cohort, period_index, value[, breakdown]). Each adversarial scenario is driven by handing the
# fake the grid rows THAT scenario's SQL would return — the SQL's cohort self-join / bounded-grid /
# per-cohort-distinct-count logic is what produces those cells; the adapter + flat-row builder are
# what this suite exercises directly (SQL shape is asserted separately). The running example is a
# signed_up -> order_placed retention over 3 weekly periods. period_index=0 is the cohort's OWN
# period throughout (the base cohort size measured via the RETURN event in the cohort's own bucket).

_RETENTION_SPEC = RetentionSpec(
    cohort_event="signed_up", return_event="order_placed", periods=3, granularity="week"
)

# A canned grid: two cohort buckets x 3 periods. period 0 is each cohort's own base (500, 420),
# decaying across subsequent periods — matching the retention_cohorts contract fixture exactly.
_RETENTION_GRID_RESULT = DbExecuteResult(
    columns=[
        DbColumn(name="cohort", type="text"),
        DbColumn(name="period_index", type="int4"),
        DbColumn(name="value", type="int8"),
    ],
    rows=[
        ("2026-07-01", 0, 500),
        ("2026-07-01", 1, 310),
        ("2026-07-01", 2, 190),
        ("2026-07-08", 0, 420),
        ("2026-07-08", 1, 250),
        ("2026-07-08", 2, 150),
    ],
)


def test_retention_computes_routes_sql_through_seam_returns_flat_rows_one_per_cell() -> None:
    fake = FakeDbExecute(_RETENTION_GRID_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    result = adapter.retention(_RETENTION_SPEC)

    assert result.rows == [
        RetentionRow(cohort="2026-07-01", period_index=0, value=500),
        RetentionRow(cohort="2026-07-01", period_index=1, value=310),
        RetentionRow(cohort="2026-07-01", period_index=2, value=190),
        RetentionRow(cohort="2026-07-08", period_index=0, value=420),
        RetentionRow(cohort="2026-07-08", period_index=1, value=250),
        RetentionRow(cohort="2026-07-08", period_index=2, value=150),
    ]
    # cohort_event + return_event are the two positional params, in that order.
    assert len(fake.calls) == 1
    assert fake.calls[0].params == ["signed_up", "order_placed"]


def test_retention_makes_one_db_execute_call_with_a_single_statement() -> None:
    fake = FakeDbExecute(_RETENTION_GRID_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    adapter.retention(_RETENTION_SPEC)

    assert len(fake.calls) == 1
    # A single statement — no semicolon-joined batch of per-cohort or per-period queries.
    assert len([s for s in fake.calls[0].sql.split(";") if s.strip()]) == 1


def test_retention_sql_self_join_granularity_bucketing_dense_grid_per_cohort_distinct() -> None:
    fake = FakeDbExecute(_RETENTION_GRID_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    adapter.retention(_RETENTION_SPEC)

    sql = fake.calls[0].sql
    # Cohort = actors who did the cohort event ($1), bucketed by granularity.
    assert "date_trunc('week', timestamp) AS cohort_bucket" in sql
    assert "WHERE event = $1" in sql
    # Return rows = the return event ($2), same granularity bucketing.
    assert "date_trunc('week', timestamp) AS return_bucket" in sql
    assert "WHERE event = $2" in sql
    # DENSE grid: generate_series over 0..periods-1 CROSS JOINed against distinct cohort buckets.
    assert "generate_series(0, 2)" in sql
    assert "CROSS JOIN generate_series(0, 2) AS p(period_index)" in sql
    assert "SELECT DISTINCT cohort_bucket FROM cohort" in sql
    # period_index=0 is the cohort's OWN bucket: return bucket is cohort_bucket + offset*interval,
    # so offset 0 targets the cohort's own bucket (not the first subsequent bucket).
    assert "g.cohort_bucket + (g.period_index * interval '1 week')" in sql
    # Per-cohort distinct-actor count (assert positively — retention legitimately uses distinct).
    assert "count(DISTINCT c.distinct_id) AS value" in sql
    # Dense LEFT JOIN so an empty cell surfaces as 0, never a gap.
    assert "LEFT JOIN cells" in sql
    assert "coalesce(cells.value, 0) AS value" in sql
    # day/week/month -> bare ISO date cohort label.
    assert "to_char(g.cohort_bucket, 'YYYY-MM-DD') AS cohort" in sql
    # Over the typed view, never the base events table.
    assert "FROM events_typed" in sql
    assert "FROM events\n" not in sql


def test_retention_adversarial_period_zero_is_the_cohort_base_not_first_return_period() -> None:
    # period_index=0 is the cohort's OWN period (the common off-by-one). The p0 cell is the cohort
    # base measured via the return event in the cohort's own bucket, NOT the first SUBSEQUENT period.
    fake = FakeDbExecute(_RETENTION_GRID_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    result = adapter.retention(_RETENTION_SPEC)

    cohort1 = [r for r in result.rows if r.cohort == "2026-07-01"]
    # p0 is the cohort's own-bucket base (500) — the largest cell; p1/p2 decay.
    assert cohort1[0] == RetentionRow(cohort="2026-07-01", period_index=0, value=500)
    assert cohort1[0].value > cohort1[1].value
    assert cohort1[1].value > cohort1[2].value
    # The offset arithmetic makes p0 target the cohort's OWN bucket (offset 0), not the next bucket.
    assert "g.cohort_bucket + (g.period_index * interval '1 week')" in fake.calls[0].sql


def test_retention_multi_cohort_grouping_shape_groups_per_cohort_bucket_no_global_dedup() -> None:
    # The GROUPING SQL SHAPE for the multi-cohort case: `GROUP BY cohort_bucket` + `count(DISTINCT)`
    # is what makes a multi-cohort actor count per-cohort rather than globally deduped. The fake
    # echoes whatever grid it is handed (it does not re-run SQL), so the REAL guard here is the
    # SQL-STRING assertion — this test pins the per-cohort GROUPING shape, NOT a builder computation.
    # The canned grid is deliberately DISTINCT from the base-case grid (different cohort labels + p0
    # bases 900/700, overlapping on a shared actor) so a reader sees the two-cohort scenario is
    # genuinely its own — and the row assertion confirms each cohort's cells pass through independently.
    multi_cohort = DbExecuteResult(
        columns=[DbColumn(name="cohort"), DbColumn(name="period_index"), DbColumn(name="value")],
        rows=[
            ("2026-06-01", 0, 900),
            ("2026-06-01", 1, 540),
            ("2026-06-01", 2, 300),
            ("2026-06-08", 0, 700),
            ("2026-06-08", 1, 420),
            ("2026-06-08", 2, 210),
        ],
    )
    fake = FakeDbExecute(multi_cohort)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    result = adapter.retention(_RETENTION_SPEC)

    c1p0 = next(r for r in result.rows if r.cohort == "2026-06-01" and r.period_index == 0)
    c2p0 = next(r for r in result.rows if r.cohort == "2026-06-08" and r.period_index == 0)
    assert c1p0 == RetentionRow(cohort="2026-06-01", period_index=0, value=900)
    assert c2p0 == RetentionRow(cohort="2026-06-08", period_index=0, value=700)
    # The REAL guard: the distinct-count is GROUPED per cohort_bucket (per-cohort), never a single
    # global count — this SQL shape is what makes a multi-cohort actor count in EACH cohort.
    assert "GROUP BY g.cohort_bucket, g.period_index" in fake.calls[0].sql
    assert "count(DISTINCT c.distinct_id)" in fake.calls[0].sql


def test_retention_adversarial_return_outside_window_contributes_to_no_cell() -> None:
    # A return event past `periods` buckets lands on no grid cell (the grid is bounded to
    # 0..periods-1) and contributes to nothing. The returned grid has exactly periods cells, with the
    # out-of-window activity NOT inflating any cell.
    bounded = DbExecuteResult(
        columns=[DbColumn(name="cohort"), DbColumn(name="period_index"), DbColumn(name="value")],
        rows=[("2026-07-01", 0, 100), ("2026-07-01", 1, 40), ("2026-07-01", 2, 12)],
    )
    fake = FakeDbExecute(bounded)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    result = adapter.retention(_RETENTION_SPEC)

    # Exactly `periods` cells for the single cohort — no period_index >= 3 leaks in.
    assert len(result.rows) == 3
    assert all(r.period_index < 3 for r in result.rows)
    # The grid is bounded by generate_series(0, periods-1); nothing past it is generated.
    assert "generate_series(0, 2)" in fake.calls[0].sql


def test_retention_adversarial_no_return_actor_counted_in_period_zero_decays_after() -> None:
    # A cohort member who never returns is counted in period 0 (the base, via the return event in
    # the cohort's own bucket) but decays to 0 in later periods; the dense LEFT JOIN emits those
    # later cells as value 0 rather than dropping them.
    no_return = DbExecuteResult(
        columns=[DbColumn(name="cohort"), DbColumn(name="period_index"), DbColumn(name="value")],
        rows=[("2026-07-01", 0, 80), ("2026-07-01", 1, 0), ("2026-07-01", 2, 0)],
    )
    fake = FakeDbExecute(no_return)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    result = adapter.retention(_RETENTION_SPEC)

    assert result.rows == [
        RetentionRow(cohort="2026-07-01", period_index=0, value=80),
        RetentionRow(cohort="2026-07-01", period_index=1, value=0),
        RetentionRow(cohort="2026-07-01", period_index=2, value=0),
    ]
    # The decayed cells are PRESENT rows with value 0 (dense), not omitted — coalesce fills them.
    assert "coalesce(cells.value, 0)" in fake.calls[0].sql


def test_retention_adversarial_sparse_cohort_zero_cell_still_emits_a_row() -> None:
    # A sparse cohort with a base (p0) and a p2 blip but a completely empty p1. The dense grid fills
    # p1 with 0 rather than skipping it — the row count stays cohorts x periods, no gaps.
    sparse = DbExecuteResult(
        columns=[DbColumn(name="cohort"), DbColumn(name="period_index"), DbColumn(name="value")],
        rows=[("2026-07-01", 0, 60), ("2026-07-01", 1, 0), ("2026-07-01", 2, 5)],
    )
    fake = FakeDbExecute(sparse)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    result = adapter.retention(_RETENTION_SPEC)

    assert len(result.rows) == 3
    assert [r.period_index for r in result.rows] == [0, 1, 2]
    assert next(r for r in result.rows if r.period_index == 1) == RetentionRow(
        cohort="2026-07-01", period_index=1, value=0
    )


def test_retention_with_a_breakdown_one_grid_per_value_stringified_on_every_row_typed_view_group_by() -> None:
    breakdown_result = DbExecuteResult(
        columns=[
            DbColumn(name="cohort"),
            DbColumn(name="period_index"),
            DbColumn(name="value"),
            DbColumn(name="breakdown"),
        ],
        rows=[
            ("2026-07-01", 0, 300, "pro"),
            ("2026-07-01", 1, 180, "pro"),
            ("2026-07-01", 0, 200, "free"),
            ("2026-07-01", 1, 60, "free"),
        ],
    )
    fake = FakeDbExecute(breakdown_result)
    adapter = WarehouseQueryAdapter(db_execute=fake, taxonomy=_BREAKDOWN_TAXONOMY)

    result = adapter.retention(
        RetentionSpec(
            cohort_event="signed_up",
            return_event="order_placed",
            periods=2,
            granularity="week",
            breakdown="plan",
        )
    )

    assert result.rows == [
        RetentionRow(cohort="2026-07-01", period_index=0, value=300, breakdown="pro"),
        RetentionRow(cohort="2026-07-01", period_index=1, value=180, breakdown="pro"),
        RetentionRow(cohort="2026-07-01", period_index=0, value=200, breakdown="free"),
        RetentionRow(cohort="2026-07-01", period_index=1, value=60, breakdown="free"),
    ]
    sql = fake.calls[0].sql
    assert '("plan")::text AS bd' in sql
    assert "GROUP BY g.cohort_bucket, g.bd, g.period_index" in sql
    # One grid per breakdown value: buckets carry the breakdown, the grid cross-joins it.
    assert "SELECT DISTINCT cohort_bucket, bd FROM cohort" in sql
    assert "properties ->>" not in sql


def test_retention_without_a_breakdown_emits_no_breakdown_path_and_rows_omit_breakdown() -> None:
    fake = FakeDbExecute(_RETENTION_GRID_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    result = adapter.retention(_RETENTION_SPEC)

    assert "properties ->>" not in fake.calls[0].sql
    for row in result.rows:
        assert row.breakdown is None


def test_retention_rows_match_the_row_type_no_engine_wire_field_leaks() -> None:
    fake = FakeDbExecute(_RETENTION_GRID_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    result = adapter.retention(_RETENTION_SPEC)

    # The frozen RetentionRow dataclass admits only cohort/period_index/value/breakdown — no engine
    # wire field can attach.
    for row in result.rows:
        assert set(vars(row).keys()) == {"cohort", "period_index", "value", "breakdown"}
        assert not hasattr(row, "breakdown_value")


def test_retention_breakdown_key_with_an_embedded_single_quote_is_identifier_quoted() -> None:
    fake = FakeDbExecute(_RETENTION_GRID_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake, taxonomy=_BREAKDOWN_TAXONOMY)

    adapter.retention(
        RetentionSpec(
            cohort_event="signed_up",
            return_event="order_placed",
            periods=3,
            granularity="week",
            breakdown="o'brien",
        )
    )

    # Identifier-quoting (double `"`, pass `'` through) — the single quote is NOT doubled here.
    assert "(\"o'brien\")::text" in fake.calls[0].sql
    assert "properties ->>" not in fake.calls[0].sql


def test_retention_day_and_month_granularity_swaps_truncation_and_offset_interval_unit() -> None:
    fake = FakeDbExecute(_RETENTION_GRID_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    adapter.retention(
        RetentionSpec(cohort_event="signed_up", return_event="order_placed", periods=3, granularity="day")
    )
    adapter.retention(
        RetentionSpec(cohort_event="signed_up", return_event="order_placed", periods=3, granularity="month")
    )

    day_sql = fake.calls[0].sql
    month_sql = fake.calls[1].sql
    assert "date_trunc('day', timestamp) AS cohort_bucket" in day_sql
    assert "g.cohort_bucket + (g.period_index * interval '1 day')" in day_sql
    assert "date_trunc('month', timestamp) AS cohort_bucket" in month_sql
    assert "g.cohort_bucket + (g.period_index * interval '1 month')" in month_sql


# The exact canonical retention SQL string for the plain 3-period weekly case. MIRRORED
# byte-for-byte in the TS warehouse adapter test — the two assertions together pin cross-tree
# retention SQL parity (the Postgres string is language-agnostic).
_CANONICAL_RETENTION_SQL = (
    "WITH cohort AS (\n"
    "  SELECT distinct_id, date_trunc('week', timestamp) AS cohort_bucket\n"
    "  FROM events_typed\n"
    "  WHERE event = $1\n"
    "  GROUP BY distinct_id, date_trunc('week', timestamp)\n"
    "),\n"
    "returns AS (\n"
    "  SELECT distinct_id, date_trunc('week', timestamp) AS return_bucket\n"
    "  FROM events_typed\n"
    "  WHERE event = $2\n"
    "  GROUP BY distinct_id, date_trunc('week', timestamp)\n"
    "),\n"
    "buckets AS (SELECT DISTINCT cohort_bucket FROM cohort),\n"
    "grid AS (\n"
    "  SELECT b.cohort_bucket, p.period_index\n"
    "  FROM buckets b\n"
    "  CROSS JOIN generate_series(0, 2) AS p(period_index)\n"
    "),\n"
    "cells AS (\n"
    "  SELECT g.cohort_bucket, g.period_index, count(DISTINCT c.distinct_id) AS value\n"
    "  FROM grid g\n"
    "  JOIN cohort c ON c.cohort_bucket = g.cohort_bucket\n"
    "  JOIN returns r ON r.distinct_id = c.distinct_id AND r.return_bucket = g.cohort_bucket + (g.period_index * interval '1 week')\n"
    "  GROUP BY g.cohort_bucket, g.period_index\n"
    ")\n"
    "SELECT to_char(g.cohort_bucket, 'YYYY-MM-DD') AS cohort, g.period_index AS period_index, coalesce(cells.value, 0) AS value\n"
    "FROM grid g\n"
    "  LEFT JOIN cells ON cells.cohort_bucket = g.cohort_bucket AND cells.period_index = g.period_index\n"
    "ORDER BY g.cohort_bucket, g.period_index"
)


def test_the_generated_retention_sql_matches_the_canonical_cross_tree_string() -> None:
    from analytics_kit.query.warehouse_sql import build_retention_sql

    query = build_retention_sql(_RETENTION_SPEC)
    assert query.sql == _CANONICAL_RETENTION_SQL


# --- S4: raw_query passes `expr` to the seam AS SQL; columns-present zip normalization -------

# A canned raw result: a driver-reported column schema + positional cell rows — exactly what a
# `SELECT` over the consumer's own schema produces. The zip keys each positional cell by column
# order, so the neutral rows are column-keyed objects (the consumer's own projection, already
# neutral). `int8`/`text` column types are the driver-reported SELECT schema, stamped on `columns`.
_RAW_RESULT = DbExecuteResult(
    columns=[
        DbColumn(name="event", type="text"),
        DbColumn(name="n", type="int8"),
    ],
    rows=[("order_placed", 1200), ("signed_up", 4300)],
)

_RAW_EXPR = "SELECT event, count(*) AS n FROM events_typed GROUP BY event"


def test_raw_query_passes_expr_to_the_seam_verbatim_as_sql() -> None:
    # `expr` reaches the DB-execute seam UNCHANGED — no HogQL/`kind` wrapping, no sanitizer, no
    # parameterization layer. It is the ONLY thing the seam is called with (no positional params).
    fake = FakeDbExecute(_RAW_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    adapter.raw_query(_RAW_EXPR)

    assert len(fake.calls) == 1
    assert fake.calls[0].sql == _RAW_EXPR
    # No `kind` discriminator / dialect envelope reached the seam — the raw SQL is passed verbatim.
    assert "kind" not in fake.calls[0].sql.lower()
    # The consumer owns `expr`: no params were synthesized around it.
    assert fake.calls[0].params is None


def test_raw_query_normalizes_via_the_columns_present_zip_path() -> None:
    # Positional cells are zipped into column-keyed objects via the driver-reported columns; the
    # neutral rows are the consumer's own SELECT projection, keyed by name (not positional).
    fake = FakeDbExecute(_RAW_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    result = adapter.raw_query(_RAW_EXPR)

    assert list(result.rows) == [
        {"event": "order_placed", "n": 1200},
        {"event": "signed_up", "n": 4300},
    ]


def test_raw_query_stamps_columns_and_generated_at_via_the_s1_assembler() -> None:
    # The S1 assembler stamps `columns` from the driver SELECT schema + `generated_at`, and omits
    # `from_cache` (a live exec has no cache envelope) — same as the four structured primitives.
    fake = FakeDbExecute(_RAW_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    result = adapter.raw_query(_RAW_EXPR)

    assert [(c.name, c.type) for c in result.columns] == [("event", "text"), ("n", "int8")]
    assert isinstance(result.generated_at, str) and result.generated_at
    assert result.from_cache is None


def test_raw_query_empty_result_still_reports_its_select_schema() -> None:
    # An empty result set still carries its SELECT schema on `columns` (the raw path stamps them via
    # the assembler), so a consumer keying on the shape survives a zero-row result.
    empty = DbExecuteResult(columns=[DbColumn(name="event"), DbColumn(name="n")], rows=[])
    fake = FakeDbExecute(empty)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    result = adapter.raw_query(_RAW_EXPR)

    assert list(result.rows) == []
    assert [(c.name, c.type) for c in result.columns] == [("event", None), ("n", None)]


def test_raw_query_returns_a_neutral_query_result_output_stays_bar_a_intact() -> None:
    # bar A on the OUTPUT: raw_query returns a neutral QueryResult regardless of the dialect-keyed
    # input. Only the INPUT `expr` is dialect-keyed; the output shape is the shared neutral one.
    from analytics_kit import QueryResult

    fake = FakeDbExecute(_RAW_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    result = adapter.raw_query(_RAW_EXPR)

    assert isinstance(result, QueryResult)


def test_raw_query_zip_twin_passes_dict_rows_through_and_yields_empty_for_other() -> None:
    # The warehouse-local `_zip_row` twin honors the pinned positional-cell behavior: a row already
    # a dict passes through unchanged; a non-list/non-dict row yields {}.
    from analytics_kit.query.warehouse_sql import _zip_row

    columns = list(_RAW_RESULT.columns)
    assert _zip_row(["order_placed", 1200], columns) == {"event": "order_placed", "n": 1200}
    assert _zip_row({"event": "x", "n": 1}, columns) == {"event": "x", "n": 1}
    assert _zip_row(42, columns) == {}
    # A short row keys the missing trailing cell as None (positional, by column order).
    assert _zip_row(["order_placed"], columns) == {"event": "order_placed", "n": None}


def test_raw_query_dialect_split_doc_names_the_split_and_no_vendor() -> None:
    # The SQL-vs-HogQL dialect split is documented on the raw_query method, stating raw_query is NOT
    # provider-swap-portable while the structured primitives are, and that the OUTPUT stays neutral.
    # The doc names no `posthog` token (HogQL is the HTTP adapter's dialect name — a dev-facing
    # contrast, kept neutral).
    import inspect as _inspect

    src = _inspect.getsource(WarehouseQueryAdapter.raw_query).lower()
    assert "dialect" in src
    assert "not provider-swap-portable" in src
    # The four structured primitives ARE portable — the contrast is stated.
    assert "provider-swap-portable" in src
    # The OUTPUT stays neutral (bar A intact on output); only the INPUT expr is dialect-keyed.
    assert "output" in src and "queryresult" in src
    assert "posthog" not in src


def test_with_no_taxonomy_the_four_non_breakdown_primitives_and_raw_query_still_run() -> None:
    # E21-S5 §3a: a no-taxonomy adapter runs every non-breakdown path — none touches the declared-key
    # set — so only a breakdown query raises; the four structured primitives + raw_query are unchanged.
    trend_fake = FakeDbExecute(_TREND_SINGLE_RESULT)
    WarehouseQueryAdapter(db_execute=trend_fake).trend(
        TrendSpec(event="order_placed", aggregation="total", window=Duration(30, "day"))
    )
    assert len(trend_fake.calls) == 1

    funnel_fake = FakeDbExecute(_FUNNEL_PLAIN_RESULT)
    WarehouseQueryAdapter(db_execute=funnel_fake).funnel(_TWO_STEP_FUNNEL_SPEC)
    assert len(funnel_fake.calls) == 1

    retention_fake = FakeDbExecute(_RETENTION_GRID_RESULT)
    WarehouseQueryAdapter(db_execute=retention_fake).retention(_RETENTION_SPEC)
    assert len(retention_fake.calls) == 1

    unique_fake = FakeDbExecute(_TREND_SINGLE_RESULT)
    WarehouseQueryAdapter(db_execute=unique_fake).unique_count(
        UniqueCountSpec(event="order_placed", window=Duration(30, "day"))
    )
    assert len(unique_fake.calls) == 1

    raw_fake = FakeDbExecute(_RAW_RESULT)
    WarehouseQueryAdapter(db_execute=raw_fake).raw_query("SELECT 1")
    assert len(raw_fake.calls) == 1
