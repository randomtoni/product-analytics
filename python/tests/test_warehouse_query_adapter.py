"""The warehouse query adapter — the typed-stub bar-A proof.

This is the story's whole reason to exist: a SECOND query backend satisfies the SAME neutral
``AnalyticsQueryClient`` Protocol as the HTTP adapter, with ZERO change to the Protocol (bar A —
provider-swap is one adapter, zero consumer change). The consolidated conformance test feeds BOTH
adapters through the shipped ``_conforms`` type-level sink (mypy proves satisfaction without
subclassing), making "two adapters, one Protocol" explicit and co-located. The stub itself does
not compute — every primitive raises a neutral not-implemented error, never a live connection.
"""

from __future__ import annotations

import inspect

import pytest
from db_execute_fakes import FakeDbExecute

from analytics_kit import (
    Duration,
    FunnelSpec,
    RetentionSpec,
    TrendRow,
    TrendSpec,
    UniqueCountRow,
    UniqueCountSpec,
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


# --- each primitive is a sync typed stub that does not compute ---------------------------


def test_the_still_unimplemented_primitives_raise_a_neutral_not_implemented_error() -> None:
    # S1 fills trend/unique_count; funnel/retention/raw_query remain S2–S4 fill-in seats.
    adapter = WarehouseQueryAdapter(db_execute=_FAKE_EXEC)
    with pytest.raises(NotImplementedError, match="warehouse query adapter is not yet implemented"):
        adapter.funnel(FunnelSpec(steps=["a", "b"], within=Duration(1, "day")))
    with pytest.raises(NotImplementedError, match="warehouse query adapter is not yet implemented"):
        adapter.retention(
            RetentionSpec(cohort_event="a", return_event="b", periods=3, granularity="day")
        )
    with pytest.raises(NotImplementedError, match="warehouse query adapter is not yet implemented"):
        adapter.raw_query("select 1")


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


def test_trend_breakdown_groups_by_jsonb_path_and_stringifies_breakdown_on_every_row() -> None:
    fake = FakeDbExecute(_TREND_BREAKDOWN_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake)

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
    assert "properties ->> 'plan'" in sql
    assert "GROUP BY date_trunc('day', timestamp), properties ->> 'plan'" in sql
    assert "CROSS JOIN series" in sql


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
    adapter = WarehouseQueryAdapter(db_execute=fake)

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


def test_a_breakdown_key_with_an_embedded_single_quote_is_sql_escaped() -> None:
    # The breakdown key is the ONE runtime consumer string that reaches the SQL text (everything
    # else is $1-bound or closed-enum-inlined). It reuses the view generator's quote-doubling
    # escaping — an embedded single quote is doubled per the SQL standard (injection-safe).
    fake = FakeDbExecute(_TREND_SINGLE_RESULT)
    adapter = WarehouseQueryAdapter(db_execute=fake)

    adapter.trend(
        TrendSpec(event="order_placed", aggregation="total", window=Duration(30, "day"), breakdown="o'brien")
    )

    assert "properties ->> 'o''brien'" in fake.calls[0].sql


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
