"""The query read seam — the ``AnalyticsQueryClient`` Protocol, specs, result, config, factory.

These pin the query surface PY5-S2 (HTTP adapter) and PY5-S3 (warehouse stub) both satisfy:
the structural-conformance ``_conforms`` sink (bar-A substrate, mypy proves satisfaction with
no subclassing), the plain-dataclass specs vs the Pydantic result/config boundary, the separate
``QueryClientConfig`` (distinct from the ingest ``AnalyticsConfig``), and the config-selected
factory / ``QueryNoop`` (bar B). Every primitive returns a synchronous ``QueryResult`` — the
sync-client posture — so no member is a coroutine.
"""

from __future__ import annotations

import dataclasses
import inspect
from typing import Any

import pytest
from db_execute_fakes import FakeDbExecute
from pydantic import BaseModel, ValidationError

from analytics_kit import (
    Aggregation,
    AnalyticsConfig,
    AnalyticsQueryClient,
    Duration,
    FunnelSpec,
    FunnelStepRow,
    Granularity,
    NeutralResponse,
    QueryClientConfig,
    QueryColumn,
    QueryNoop,
    QueryResult,
    QueryTransport,
    RetentionRow,
    RetentionSpec,
    TrendRow,
    TrendSpec,
    UniqueCountRow,
    UniqueCountSpec,
    WarehouseQueryAdapter,
    create_query_client,
    define_taxonomy,
)


def _conforms(client: AnalyticsQueryClient) -> None:
    """Structural-conformance sink — mypy proves satisfaction without inheritance.

    S2's ``HttpQueryAdapter`` and S3's ``WarehouseQueryAdapter`` are checked against this same
    sink unchanged (the bar-A proof: two adapters, one Protocol, seam unchanged).
    """


class _AltQueryClient:
    """A second, unrelated shape satisfying the Protocol — the two-shapes-one-Protocol proof.

    Not a subclass of anything query-related; it conforms by SHAPE alone, standing in for a
    future adapter (the HTTP adapter, the warehouse stub) so bar A is provable in S1.
    """

    def funnel(self, spec: FunnelSpec) -> QueryResult[FunnelStepRow]:
        return _fixed_result()

    def retention(self, spec: RetentionSpec) -> QueryResult[RetentionRow]:
        return _fixed_result()

    def trend(self, spec: TrendSpec) -> QueryResult[TrendRow]:
        return _fixed_result()

    def unique_count(self, spec: UniqueCountSpec) -> QueryResult[UniqueCountRow]:
        return _fixed_result()

    def raw_query(self, expr: str) -> QueryResult:
        return _fixed_result()


class _RecordingTransport:
    """A query transport that records every send — satisfies ``QueryTransport`` by shape."""

    def __init__(self) -> None:
        self.sends: list[tuple[str, str, dict[str, str], str | None]] = []

    def send(
        self,
        url: str,
        method: str,
        headers: dict[str, str],
        body: str | None = None,
    ) -> NeutralResponse:
        self.sends.append((url, method, headers, body))
        return NeutralResponse(status=200, body="{}")


def _fixed_result() -> QueryResult[Any]:
    # An empty result (rows=[]) is compatible with any TRow parametrization — the four narrowed
    # _AltQueryClient methods and raw_query all return it; the Any row type unifies with each.
    return QueryResult(rows=[], columns=[], generated_at="2026-07-10T00:00:00+00:00")


# --- Protocol: exactly five sync members, structural conformance -------------------------


def test_query_noop_conforms_to_protocol_structurally() -> None:
    client = QueryNoop()
    _conforms(client)
    assert AnalyticsQueryClient not in type(client).__mro__


def test_an_unrelated_shape_conforms_without_subclassing() -> None:
    # Bar A: a second, independent shape satisfies the SAME Protocol with zero consumer change.
    client = _AltQueryClient()
    _conforms(client)
    assert AnalyticsQueryClient not in type(client).__mro__


def test_protocol_has_exactly_the_five_members() -> None:
    members = {
        name
        for name in dir(AnalyticsQueryClient)
        if not name.startswith("_")
    }
    assert members == {"funnel", "retention", "trend", "unique_count", "raw_query"}


def test_every_primitive_is_sync_not_a_coroutine() -> None:
    for member in ("funnel", "retention", "trend", "unique_count", "raw_query"):
        assert not inspect.iscoroutinefunction(getattr(QueryNoop, member))


def test_every_primitive_returns_a_query_result() -> None:
    client = QueryNoop()
    assert isinstance(client.funnel(FunnelSpec(steps=["a", "b"], within=Duration(1, "day"))), QueryResult)
    assert isinstance(
        client.retention(
            RetentionSpec(cohort_event="a", return_event="b", periods=7, granularity="day")
        ),
        QueryResult,
    )
    assert isinstance(
        client.trend(TrendSpec(event="a", aggregation="total", window=Duration(7, "day"))),
        QueryResult,
    )
    assert isinstance(
        client.unique_count(UniqueCountSpec(event="a", window=Duration(7, "day"))),
        QueryResult,
    )
    assert isinstance(client.raw_query("select 1"), QueryResult)


# --- specs are plain dataclasses (outbound), NOT Pydantic --------------------------------


def test_spec_types_are_plain_dataclasses_not_pydantic() -> None:
    for spec in (FunnelSpec, RetentionSpec, TrendSpec, UniqueCountSpec, Duration):
        assert dataclasses.is_dataclass(spec)
        assert not issubclass(spec, BaseModel)


def test_funnel_spec_fields() -> None:
    spec = FunnelSpec(steps=["signed_up", "activated"], within=Duration(7, "day"))
    assert spec.steps == ["signed_up", "activated"]
    assert spec.within == Duration(7, "day")
    assert spec.breakdown is None
    assert FunnelSpec(steps=["a"], within=Duration(1, "hour"), breakdown="plan").breakdown == "plan"


def test_retention_spec_fields() -> None:
    spec = RetentionSpec(
        cohort_event="signed_up", return_event="opened", periods=8, granularity="week"
    )
    assert spec.cohort_event == "signed_up"
    assert spec.return_event == "opened"
    assert spec.periods == 8
    assert spec.granularity == "week"
    assert spec.breakdown is None


def test_trend_and_unique_count_spec_fields() -> None:
    trend = TrendSpec(event="opened", aggregation="unique", window=Duration(30, "day"))
    assert trend.event == "opened"
    assert trend.aggregation == "unique"
    assert trend.window == Duration(30, "day")

    unique = UniqueCountSpec(event="opened", window=Duration(1, "week"), breakdown="plan")
    assert unique.event == "opened"
    assert unique.window == Duration(1, "week")
    assert unique.breakdown == "plan"


def test_value_types_carry_neutral_vocabulary() -> None:
    # The value-type units/aggregations/granularities name no vendor or query-dialect concept.
    duration = Duration(value=2, unit="month")
    assert duration.value == 2
    assert duration.unit == "month"
    granularity: Granularity = "month"
    aggregation: Aggregation = "dau"
    assert granularity == "month"
    assert aggregation == "dau"


# --- QueryResult / QueryColumn: the one inbound-wire boundary (Pydantic) -----------------


def test_result_and_column_are_pydantic_models() -> None:
    assert issubclass(QueryResult, BaseModel)
    assert issubclass(QueryColumn, BaseModel)


def test_query_result_decodes_a_well_formed_wire_dict() -> None:
    result = QueryResult.model_validate(
        {
            "rows": [{"date": "2026-07-01", "count": 5}],
            "columns": [{"name": "date"}, {"name": "count", "type": "int"}],
            "generated_at": "2026-07-10T00:00:00+00:00",
            "from_cache": True,
        }
    )
    assert result.rows == [{"date": "2026-07-01", "count": 5}]
    assert result.columns[1].name == "count"
    assert result.columns[1].type == "int"
    assert result.from_cache is True


def test_query_result_from_cache_is_optional() -> None:
    # The wire flag is present only on cached responses — an absent from_cache decodes to None.
    result = QueryResult.model_validate(
        {"rows": [], "columns": [], "generated_at": "2026-07-10T00:00:00+00:00"}
    )
    assert result.from_cache is None


def test_query_column_type_is_optional() -> None:
    assert QueryColumn.model_validate({"name": "date"}).type is None
    assert QueryColumn.model_validate({"name": "date", "type": "date"}).type == "date"


def test_empty_result_still_carries_a_columns_list() -> None:
    # columns is a DISTINCT ordered list — an empty result carries its schema, not just [].
    result = QueryResult(rows=[], columns=[QueryColumn(name="date")], generated_at="t")
    assert result.rows == []
    assert [c.name for c in result.columns] == ["date"]


def test_row_cells_are_untyped_object_values() -> None:
    # Cell values are engine-reported and untyped — a mixed-type row decodes intact.
    result = QueryResult.model_validate(
        {
            "rows": [{"n": 1, "s": "x", "b": True, "f": 1.5}],
            "columns": [],
            "generated_at": "t",
        }
    )
    assert result.rows[0] == {"n": 1, "s": "x", "b": True, "f": 1.5}


def test_query_result_rejects_a_bad_wire_dict() -> None:
    # rows must be a list of dicts — a malformed wire response fails at THIS boundary.
    with pytest.raises(ValidationError):
        QueryResult.model_validate(
            {"rows": "not-a-list", "columns": [], "generated_at": "t"}
        )


def test_query_result_rejects_missing_required_field() -> None:
    with pytest.raises(ValidationError):
        QueryResult.model_validate({"rows": [], "columns": []})  # no generated_at


# --- QueryClientConfig: distinct from AnalyticsConfig, forbid + arbitrary types ----------


def test_query_config_is_a_distinct_pydantic_model() -> None:
    assert issubclass(QueryClientConfig, BaseModel)
    assert QueryClientConfig.__name__ != AnalyticsConfig.__name__
    assert not issubclass(QueryClientConfig, AnalyticsConfig)


def test_query_config_fields_do_not_alias_the_ingest_config() -> None:
    # The query read key/endpoint/project fields are DISTINCT names from the ingest write side.
    query_fields = set(QueryClientConfig.model_fields)
    ingest_fields = set(AnalyticsConfig.model_fields)
    assert "personal_key" in query_fields
    assert "query_endpoint" in query_fields
    assert "project_id" in query_fields
    # None of the ingest write-side names leak onto the query config.
    assert "key" not in query_fields
    assert "ingest_host" not in query_fields
    assert "ingest_path" not in query_fields
    # And the query read-key/endpoint names are not on the ingest config either.
    assert query_fields.isdisjoint({"key", "ingest_host", "ingest_path"})
    assert ingest_fields.isdisjoint({"personal_key", "query_endpoint", "project_id"})


def test_query_config_defaults_are_none() -> None:
    config = QueryClientConfig()
    assert config.warehouse_dsn is None
    assert config.query_endpoint is None
    assert config.personal_key is None
    assert config.project_id is None
    assert config.taxonomy is None
    assert config.transport is None


def test_query_config_accepts_its_fields() -> None:
    transport = _RecordingTransport()
    config = QueryClientConfig(
        warehouse_dsn="postgresql://localhost/analytics",
        query_endpoint="https://query.example",
        personal_key="phx_read",
        project_id="42",
        transport=transport,
    )
    assert config.warehouse_dsn == "postgresql://localhost/analytics"
    assert config.query_endpoint == "https://query.example"
    assert config.personal_key == "phx_read"
    assert config.project_id == "42"
    assert config.transport is transport


def test_query_config_carries_warehouse_dsn_and_still_forbids_extras() -> None:
    # The warehouse_dsn field is on the surface; extra="forbid" is preserved (a typo still raises).
    assert "warehouse_dsn" in QueryClientConfig.model_fields
    assert QueryClientConfig(warehouse_dsn="postgresql://localhost/db").warehouse_dsn == (
        "postgresql://localhost/db"
    )
    with pytest.raises(ValidationError):
        QueryClientConfig(warehouse_dsnn="postgresql://localhost/db")  # type: ignore[call-arg]


def test_query_config_forbids_unknown_keys() -> None:
    # A typo raises loudly, never silently degrades.
    with pytest.raises(ValidationError):
        QueryClientConfig(personal_keyy="phx_read")  # type: ignore[call-arg]


def test_query_config_holds_taxonomy_opaque_and_rejects_raw_dict() -> None:
    taxonomy = define_taxonomy({"events": {"signed_up": {"plan": "string"}}})
    config = QueryClientConfig(taxonomy=taxonomy)
    assert config.taxonomy is taxonomy
    # arbitrary_types_allowed holds the Taxonomy opaque; a raw dict fails at THIS boundary.
    with pytest.raises(ValidationError):
        QueryClientConfig(taxonomy={"events": {}})  # type: ignore[arg-type]


def test_query_config_rejects_wrong_field_type() -> None:
    with pytest.raises(ValidationError):
        QueryClientConfig(query_endpoint=123)  # type: ignore[arg-type]


# --- create_query_client: unkeyed ⇒ QueryNoop (bar B); keyed+endpointed ⇒ HTTP branch ----


def test_unkeyed_config_returns_a_query_noop() -> None:
    client = create_query_client(QueryClientConfig())
    assert isinstance(client, QueryNoop)


def test_keyed_but_endpointless_config_returns_a_query_noop() -> None:
    # A personal key with no endpoint has nowhere to go — the no-op, not a broken adapter.
    client = create_query_client(QueryClientConfig(personal_key="phx_read"))
    assert isinstance(client, QueryNoop)


def test_query_noop_primitives_return_empty_results() -> None:
    # Bar B: an unconfigured environment queries nothing and gets empty data, never an error.
    client = create_query_client(QueryClientConfig())
    for result in (
        client.funnel(FunnelSpec(steps=["a", "b"], within=Duration(1, "day"))),
        client.retention(
            RetentionSpec(cohort_event="a", return_event="b", periods=3, granularity="day")
        ),
        client.trend(TrendSpec(event="a", aggregation="total", window=Duration(7, "day"))),
        client.unique_count(UniqueCountSpec(event="a", window=Duration(7, "day"))),
        client.raw_query("select 1"),
    ):
        assert isinstance(result, QueryResult)
        assert result.rows == []
        assert result.columns == []
        assert result.from_cache is None
        assert result.generated_at  # a real ISO stamp, not empty


def test_keyed_and_endpointed_config_selects_the_http_adapter_branch() -> None:
    # Keyed + endpointed selects the HTTP query adapter (PY5-S2), not the no-op — a configured
    # environment queries the endpoint. The adapter satisfies AnalyticsQueryClient structurally.
    from analytics_kit.query.http_adapter import HttpQueryAdapter

    client = create_query_client(
        QueryClientConfig(query_endpoint="https://query.example", personal_key="phx_read")
    )
    assert isinstance(client, HttpQueryAdapter)
    assert not isinstance(client, QueryNoop)


# --- create_query_client: the warehouse rung — warehouse_dsn present ⇒ warehouse (first rung) ---
#
# The factory's warehouse rung builds the default DB-execute driver from the DSN, which requires
# the `analytics-kit[warehouse]` extra (not installed in the dev env). These tests inject the S3
# FAKE exec at the driver-build boundary (`create_default_db_execute`) so selection + construction
# are proven with NO real Postgres — exactly the AC's "S3 fake seam, no real Postgres".


def _patch_default_db_execute(monkeypatch: pytest.MonkeyPatch) -> FakeDbExecute:
    fake = FakeDbExecute()
    monkeypatch.setattr(
        "analytics_kit.query.warehouse_adapter.create_default_db_execute",
        lambda _dsn: fake,
    )
    return fake


def test_warehouse_dsn_present_selects_the_warehouse_adapter_first_rung(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from analytics_kit.query.http_adapter import HttpQueryAdapter

    _patch_default_db_execute(monkeypatch)
    client = create_query_client(QueryClientConfig(warehouse_dsn="postgresql://localhost/analytics"))

    assert isinstance(client, WarehouseQueryAdapter)
    assert not isinstance(client, HttpQueryAdapter)
    assert not isinstance(client, QueryNoop)


def test_warehouse_dsn_wins_over_a_full_http_config_precedence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from analytics_kit.query.http_adapter import HttpQueryAdapter

    _patch_default_db_execute(monkeypatch)
    # A fully keyed + endpointed config that ALSO carries warehouse_dsn: presence of the DSN wins
    # (the warehouse rung sits ahead of the personal_key ladder), so HTTP is never reached.
    client = create_query_client(
        QueryClientConfig(
            warehouse_dsn="postgresql://localhost/analytics",
            personal_key="phx_read",
            query_endpoint="https://query.example",
            project_id="42",
        )
    )
    assert isinstance(client, WarehouseQueryAdapter)
    assert not isinstance(client, HttpQueryAdapter)


def test_warehouse_rung_builds_the_default_driver_from_the_dsn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The factory reads warehouse_dsn and threads it into the driver build — proving the DSN is
    # read at the boundary (not stored on the adapter).
    seen: list[str] = []
    fake = FakeDbExecute()

    def _record(dsn: str) -> FakeDbExecute:
        seen.append(dsn)
        return fake

    monkeypatch.setattr(
        "analytics_kit.query.warehouse_adapter.create_default_db_execute", _record
    )
    create_query_client(QueryClientConfig(warehouse_dsn="postgresql://u:p@localhost/analytics"))

    assert seen == ["postgresql://u:p@localhost/analytics"]


def test_warehouse_adapter_holds_only_the_opaque_db_execute_never_the_dsn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The adapter never sees a DSN or driver handle — its only injected field is the opaque exec.
    fake = _patch_default_db_execute(monkeypatch)
    client = create_query_client(
        QueryClientConfig(warehouse_dsn="postgresql://user:secret@localhost/analytics")
    )

    assert isinstance(client, WarehouseQueryAdapter)
    field_values = list(vars(client).values())
    assert fake in field_values
    for value in field_values:
        assert not (isinstance(value, str) and "postgresql://" in value)
        assert not (isinstance(value, str) and "secret" in value)


def test_no_warehouse_dsn_leaves_the_existing_ladder_unchanged() -> None:
    # Without warehouse_dsn the existing rungs are untouched: unkeyed ⇒ no-op, keyed+endpointed ⇒
    # HTTP. No driver build is attempted, so no warehouse extra is needed here.
    from analytics_kit.query.http_adapter import HttpQueryAdapter

    assert isinstance(create_query_client(QueryClientConfig()), QueryNoop)
    http = create_query_client(
        QueryClientConfig(personal_key="phx_read", query_endpoint="https://query.example")
    )
    assert isinstance(http, HttpQueryAdapter)


# --- raw_query returns the result CONTRACT, only the LANGUAGE is a string -----------------


def test_raw_query_takes_a_string_and_returns_a_query_result() -> None:
    client = QueryNoop()
    sig = inspect.signature(QueryNoop.raw_query)
    assert list(sig.parameters)[1] == "expr"
    result = client.raw_query("select count() from events")
    assert isinstance(result, QueryResult)


# --- neutrality: no query-dialect vocabulary on the surface ------------------------------


def test_query_transport_is_a_neutral_send_hook() -> None:
    # The transport hook mirrors the neutral SPI send — one method-carrying call, neutral
    # response — so no vendor/library client handle crosses the seam.
    transport = _RecordingTransport()
    hook: QueryTransport = transport
    response = hook.send("https://query.example", "POST", {"Authorization": "Bearer x"}, "{}")
    assert isinstance(response, NeutralResponse)
    assert transport.sends[0][1] == "POST"


def test_no_query_dialect_token_leaks_onto_the_public_surface() -> None:
    # The R1 leak class: a HogQL/query-kind token must never surface as a type on the neutral
    # read surface. raw_query carries the dialect as a VALUE (the expr string), never a type.
    import analytics_kit.query as query

    forbidden = ("hogql", "insightviznode", "eventsnode", "trendsquery", "funnelsquery")
    surface = " ".join(query.__all__).lower()
    for token in forbidden:
        assert token not in surface
