"""The HTTP query adapter — spec→wire translation, sync-blocking poll, wire→result decode.

Every assertion runs against an INJECTED mock transport returning canned envelopes (immediate +
async-status-then-complete) — never a real network. The tests pin: the correct URL/method/Bearer
header + kind body per primitive; the sync-blocking poll resolving the async-status variant with an
injected no-op wait (no real sleep); attempts-exhausted and the wire ``error`` flag surfacing a
neutral error (never an infinite loop); async-detection keying on ``complete`` not on presence of
the status key; the envelope→``QueryResult`` normalization (rows keyed by column, ``from_cache``
read defensively); ``raw_query`` sharing the same POST path/result; fetch-failure normalization at
the boundary (a raising/non-OK transport yields a neutral error, no raw leak); and ``_WIRE_*``
confinement (no dialect token on the neutral surface or exports).
"""

from __future__ import annotations

import json
from typing import Any, cast

import pytest

from analytics_kit import (
    Duration,
    FunnelSpec,
    FunnelStepRow,
    NeutralResponse,
    QueryClientConfig,
    QueryResult,
    RetentionSpec,
    RetentionRow,
    TrendRow,
    TrendSpec,
    UniqueCountRow,
    UniqueCountSpec,
    create_query_client,
)
from analytics_kit.query.http_adapter import (
    POLL_MAX_ATTEMPTS,
    HttpQueryAdapter,
    _QueryError,
    _UrllibQueryTransport,
    create_http_query_adapter,
)

from query_contract_fixtures import (
    ENGINE_ROW_FIELD_NAMES,
    funnel_breakdown,
    funnel_event_precedence,
    funnel_plain,
    funnel_zero_first_step,
    retention_cohorts,
    trend_breakdown,
    trend_single_series,
    unique_count_single_series,
)


class _Send:
    """One recorded transport send."""

    def __init__(self, url: str, method: str, headers: dict[str, str], body: str | None) -> None:
        self.url = url
        self.method = method
        self.headers = headers
        self.body = body

    @property
    def query_body(self) -> dict[str, Any]:
        assert self.body is not None
        return cast("dict[str, Any]", json.loads(self.body))


class _CannedTransport:
    """A mock transport that records every send and replays canned responses in order.

    ``responses`` is a queue of ``NeutralResponse`` (or a callable raising) consumed one per send;
    once exhausted the last response repeats, so a long poll loop can drive off one 'still pending'
    response. Never touches a network.
    """

    def __init__(self, responses: list[NeutralResponse]) -> None:
        self._responses = responses
        self.sends: list[_Send] = []

    def send(
        self,
        url: str,
        method: str,
        headers: dict[str, str],
        body: str | None = None,
    ) -> NeutralResponse:
        self.sends.append(_Send(url, method, headers, body))
        idx = min(len(self.sends) - 1, len(self._responses) - 1)
        return self._responses[idx]


class _RaisingTransport:
    """A transport whose send raises — the fetch-failure negative-control driver."""

    def __init__(self, exc: Exception) -> None:
        self._exc = exc
        self.sends = 0

    def send(
        self,
        url: str,
        method: str,
        headers: dict[str, str],
        body: str | None = None,
    ) -> NeutralResponse:
        self.sends += 1
        raise self._exc


def _ok(payload: dict[str, object]) -> NeutralResponse:
    return NeutralResponse(status=200, body=json.dumps(payload))


def _immediate(**extra: object) -> NeutralResponse:
    body: dict[str, object] = {
        "results": [[1, 2]],
        "columns": ["a", "b"],
        "types": ["int", "int"],
    }
    body.update(extra)
    return _ok(body)


def _no_op_wait(_seconds: float) -> None:
    return None


def _adapter(
    transport: _CannedTransport | _RaisingTransport,
    *,
    project_id: str = "42",
    personal_key: str = "phx_read",
) -> HttpQueryAdapter:
    return HttpQueryAdapter(
        query_endpoint="https://query.example/",
        personal_key=personal_key,
        project_id=project_id,
        transport=transport,
        wait=_no_op_wait,
    )


# --- URL / method / auth header per primitive -------------------------------------------


def test_each_primitive_posts_to_the_project_scoped_url_with_bearer_auth() -> None:
    transport = _CannedTransport([_immediate()])
    adapter = _adapter(transport)

    adapter.funnel(FunnelSpec(steps=["a", "b"], within=Duration(7, "day")))

    send = transport.sends[0]
    assert send.url == "https://query.example/api/projects/42/query/"
    assert send.method == "POST"
    assert send.headers["Authorization"] == "Bearer phx_read"
    assert send.headers["Content-Type"] == "application/json"


def test_trailing_slash_on_endpoint_is_not_doubled() -> None:
    transport = _CannedTransport([_immediate()])
    adapter = HttpQueryAdapter(
        query_endpoint="https://query.example",
        personal_key="k",
        project_id="7",
        transport=transport,
        wait=_no_op_wait,
    )
    adapter.raw_query("select 1")
    assert transport.sends[0].url == "https://query.example/api/projects/7/query/"


# --- kind body per primitive ------------------------------------------------------------


def test_funnel_sends_the_funnel_kind_body() -> None:
    transport = _CannedTransport([_immediate()])
    _adapter(transport).funnel(
        FunnelSpec(steps=["signed_up", "activated"], within=Duration(3, "day"), breakdown="plan")
    )
    query = transport.sends[0].query_body["query"]
    assert isinstance(query, dict)
    assert query["kind"] == "FunnelsQuery"
    assert [s["event"] for s in query["series"]] == ["signed_up", "activated"]
    assert query["funnelsFilter"] == {
        "funnelWindowInterval": 3,
        "funnelWindowIntervalUnit": "day",
    }
    assert query["breakdownFilter"] == {"breakdown": "plan", "breakdown_type": "event"}
    assert transport.sends[0].query_body["refresh"] == "async"


def test_retention_sends_the_retention_kind_body() -> None:
    transport = _CannedTransport([_immediate()])
    _adapter(transport).retention(
        RetentionSpec(cohort_event="signed_up", return_event="opened", periods=8, granularity="week")
    )
    query = transport.sends[0].query_body["query"]
    assert query["kind"] == "RetentionQuery"
    rf = query["retentionFilter"]
    assert rf["targetEntity"]["id"] == "signed_up"
    assert rf["returningEntity"]["id"] == "opened"
    assert rf["period"] == "Week"
    assert rf["totalIntervals"] == 8


def test_trend_sends_the_trend_kind_body_with_math_and_interval() -> None:
    transport = _CannedTransport([_immediate()])
    _adapter(transport).trend(
        TrendSpec(event="opened", aggregation="unique", window=Duration(30, "day"))
    )
    query = transport.sends[0].query_body["query"]
    assert query["kind"] == "TrendsQuery"
    assert query["series"][0]["event"] == "opened"
    assert query["series"][0]["math"] == "dau"  # unique -> dau
    assert query["interval"] == "day"
    assert query["dateRange"] == {"date_from": "-30d"}


def test_unique_count_sends_a_trend_body_with_dau_math() -> None:
    transport = _CannedTransport([_immediate()])
    _adapter(transport).unique_count(UniqueCountSpec(event="opened", window=Duration(1, "week")))
    query = transport.sends[0].query_body["query"]
    assert query["kind"] == "TrendsQuery"
    assert query["series"][0]["math"] == "dau"
    assert query["interval"] == "week"
    assert query["dateRange"] == {"date_from": "-1w"}


def test_raw_query_sends_the_raw_kind_body_carrying_the_expr() -> None:
    transport = _CannedTransport([_immediate()])
    _adapter(transport).raw_query("select count() from events")
    query = transport.sends[0].query_body["query"]
    assert query["kind"] == "HogQLQuery"
    assert query["query"] == "select count() from events"


def test_minute_and_hour_windows_map_to_the_hour_interval() -> None:
    transport = _CannedTransport([_immediate(), _immediate()])
    adapter = _adapter(transport)
    adapter.trend(TrendSpec(event="e", aggregation="total", window=Duration(5, "minute")))
    adapter.trend(TrendSpec(event="e", aggregation="total", window=Duration(5, "hour")))
    assert transport.sends[0].query_body["query"]["interval"] == "hour"
    assert transport.sends[1].query_body["query"]["interval"] == "hour"
    assert transport.sends[0].query_body["query"]["series"][0]["math"] == "total"


def test_breakdown_is_omitted_when_absent() -> None:
    transport = _CannedTransport([_immediate()])
    _adapter(transport).trend(TrendSpec(event="e", aggregation="total", window=Duration(7, "day")))
    assert "breakdownFilter" not in transport.sends[0].query_body["query"]


# --- envelope -> QueryResult normalization ----------------------------------------------


def test_immediate_envelope_normalizes_rows_keyed_by_column() -> None:
    # The columns-present cell-array zip belongs to raw_query — the ONE primitive that consults
    # columns. (A structured insight response never carries columns; that coverage moved here off
    # funnel, which now flattens a real insight shape — see the funnel-insight test below.)
    transport = _CannedTransport([_immediate()])
    result = _adapter(transport).raw_query("select a, b from events")
    assert isinstance(result, QueryResult)
    assert result.rows == [{"a": 1, "b": 2}]
    assert [c.name for c in result.columns] == ["a", "b"]
    assert [c.type for c in result.columns] == ["int", "int"]
    assert result.generated_at


def _funnel_insight(**extra: object) -> NeutralResponse:
    """A real funnel insight envelope: per-step objects (no columns), the columns-ABSENT branch."""
    body: dict[str, object] = {"results": list(funnel_plain.wire_results)}
    body.update(extra)
    return _ok(body)


def test_immediate_funnel_insight_flattens_to_neutral_funnel_step_rows() -> None:
    # After S2, funnel reads a per-step insight shape (order/count/name), NOT a columns-present
    # cell-array — it flattens to FunnelStepRows with a computed conversion_rate.
    transport = _CannedTransport([_funnel_insight()])
    result = _adapter(transport).funnel(FunnelSpec(steps=["a"], within=Duration(1, "day")))
    assert isinstance(result, QueryResult)
    assert result.rows == funnel_plain.expected_rows
    assert all(isinstance(row, FunnelStepRow) for row in result.rows)
    # A structured insight carries no columns — the result is built with columns=[] so a spurious
    # wire columns array can never re-surface engine column names.
    assert result.columns == []
    assert result.generated_at


def test_from_cache_is_read_defensively_present_only_when_the_flag_is_set() -> None:
    with_cache = _CannedTransport([_immediate(is_cached=True)])
    assert _adapter(with_cache).raw_query("q").from_cache is True

    without_cache = _CannedTransport([_immediate()])
    assert _adapter(without_cache).raw_query("q").from_cache is None


def test_columns_absent_rows_pass_through_as_records() -> None:
    transport = _CannedTransport([_ok({"results": [{"x": 1}, {"y": 2}]})])
    result = _adapter(transport).raw_query("q")
    assert result.rows == [{"x": 1}, {"y": 2}]
    assert result.columns == []


def test_empty_result_still_carries_its_column_schema() -> None:
    transport = _CannedTransport([_ok({"results": [], "columns": ["a"], "types": ["int"]})])
    result = _adapter(transport).raw_query("q")
    assert result.rows == []
    assert [c.name for c in result.columns] == ["a"]


# --- sync-blocking poll: async-status-then-complete -------------------------------------


def _pending(status_id: str = "q-1") -> NeutralResponse:
    return _ok({"query_status": {"id": status_id, "complete": False}})


def _complete(**extra: object) -> NeutralResponse:
    # A real trend insight (days/data, the columns-ABSENT branch) inside a completed status — so a
    # polled trend flattens to the same TrendRows an inline one does.
    status: dict[str, object] = {
        "id": "q-1",
        "complete": True,
        "results": list(trend_single_series.wire_results),
    }
    status.update(extra)
    return _ok({"query_status": status})


def test_async_status_is_polled_until_complete_then_normalized() -> None:
    transport = _CannedTransport([_pending(), _pending(), _complete()])
    result = _adapter(transport).trend(
        TrendSpec(event="e", aggregation="total", window=Duration(7, "day"))
    )
    # The polled result flattens to the neutral TrendRows (identical to the inline path).
    assert result.rows == trend_single_series.expected_rows
    assert all(isinstance(row, TrendRow) for row in result.rows)
    # POST submit + two GET polls (second returns complete) — the poll plumbing is unchanged.
    assert transport.sends[0].method == "POST"
    assert transport.sends[1].method == "GET"
    assert transport.sends[1].url == "https://query.example/api/projects/42/query/q-1/"
    assert len([s for s in transport.sends if s.method == "GET"]) == 2


def test_immediate_result_returns_without_polling() -> None:
    transport = _CannedTransport([_immediate()])
    _adapter(transport).raw_query("q")
    assert len(transport.sends) == 1  # POST only, no poll GET


def test_a_completed_status_in_the_post_response_does_not_poll() -> None:
    # The async-detection foot-gun: a completed poll STILL carries query_status. Keying on
    # presence would loop forever; keying on complete != True resolves immediately. Driven through
    # raw_query, whose columns-absent branch passes the wire result objects through verbatim.
    transport = _CannedTransport([_complete()])
    result = _adapter(transport).raw_query("q")
    assert result.rows == list(trend_single_series.wire_results)
    assert len(transport.sends) == 1  # no extra poll GET — detection keys on complete, not presence


def test_poll_gives_up_after_max_attempts_with_a_neutral_error() -> None:
    # Never-completing: every poll stays pending. Bounded — raises after POLL_MAX_ATTEMPTS, never
    # an infinite loop.
    transport = _CannedTransport([_pending()])
    with pytest.raises(_QueryError):
        _adapter(transport).raw_query("q")
    # 1 POST + POLL_MAX_ATTEMPTS GET polls, then give up.
    assert len(transport.sends) == 1 + POLL_MAX_ATTEMPTS


def test_a_wire_error_flag_on_a_completed_status_surfaces_a_neutral_error() -> None:
    transport = _CannedTransport([_ok({"query_status": {"id": "q-1", "complete": True, "error": True}})])
    with pytest.raises(_QueryError):
        _adapter(transport).raw_query("q")


def test_an_errored_but_incomplete_poll_short_circuits_before_exhausting_the_budget() -> None:
    # A backend reporting error:true while still incomplete must fail FAST, not poll the whole
    # budget: POST submit (pending) → first poll GET (errored) short-circuits. Before the fix the
    # error flag was only read once complete, so this polled all POLL_MAX_ATTEMPTS before failing.
    errored_incomplete = _ok({"query_status": {"id": "q-1", "complete": False, "error": True}})
    transport = _CannedTransport([_pending(), errored_incomplete])
    with pytest.raises(_QueryError):
        _adapter(transport).raw_query("q")
    assert len(transport.sends) == 2  # 1 POST + exactly 1 poll GET, NOT 1 + POLL_MAX_ATTEMPTS


def test_a_completed_status_missing_its_status_id_is_a_neutral_error() -> None:
    # An incomplete status with no id has nowhere to poll — a bounded give-up, not a hang.
    transport = _CannedTransport([_ok({"query_status": {"complete": False}})])
    with pytest.raises(_QueryError):
        _adapter(transport).raw_query("q")


def test_poll_response_missing_the_status_key_is_a_neutral_error() -> None:
    transport = _CannedTransport([_pending(), _ok({"results": []})])
    with pytest.raises(_QueryError):
        _adapter(transport).raw_query("q")


# --- fetch-failure normalization (negative control) -------------------------------------


def test_a_non_ok_status_raises_a_neutral_error_not_a_raw_status() -> None:
    transport = _CannedTransport([NeutralResponse(status=500, body="upstream boom")])
    with pytest.raises(_QueryError):
        _adapter(transport).raw_query("q")


def test_a_raising_transport_is_normalized_to_a_neutral_error() -> None:
    # The named negative-control: a connection/timeout exception NEVER leaks raw onto the neutral
    # surface — it is caught at the boundary and re-raised as the neutral query error.
    class _Boom(Exception):
        pass

    transport = _RaisingTransport(_Boom("connection reset"))
    with pytest.raises(_QueryError):
        _adapter(transport).raw_query("q")
    assert transport.sends == 1


def test_a_malformed_response_body_surfaces_a_neutral_error() -> None:
    transport = _CannedTransport([NeutralResponse(status=200, body="not json")])
    with pytest.raises(_QueryError):
        _adapter(transport).raw_query("q")


def test_an_envelope_missing_results_surfaces_a_neutral_error() -> None:
    transport = _CannedTransport([_ok({"columns": ["a"]})])
    with pytest.raises(_QueryError):
        _adapter(transport).raw_query("q")


# --- default transport is stdlib and neutral --------------------------------------------


def test_default_transport_is_the_stdlib_urllib_transport() -> None:
    adapter = create_http_query_adapter(
        QueryClientConfig(query_endpoint="https://q.example", personal_key="k", project_id="1")
    )
    assert isinstance(adapter._transport, _UrllibQueryTransport)


def test_factory_wires_the_adapter_via_create_query_client() -> None:
    client = create_query_client(
        QueryClientConfig(query_endpoint="https://q.example", personal_key="k", project_id="1")
    )
    assert isinstance(client, HttpQueryAdapter)


# --- _WIRE_* confinement: no dialect token on the neutral surface / exports --------------


def test_no_wire_dialect_token_leaks_onto_the_public_surface() -> None:
    import analytics_kit
    import analytics_kit.query as query

    forbidden = (
        "hogql",
        "eventsnode",
        "trendsquery",
        "funnelsquery",
        "retentionquery",
        "insightviznode",
        "bearer",
    )
    surface = (" ".join(analytics_kit.__all__) + " " + " ".join(query.__all__)).lower()
    for token in forbidden:
        assert token not in surface


def test_wire_kind_tokens_are_confined_to_module_level_wire_constants() -> None:
    # Every dialect token lives in a _WIRE_* constant inside the adapter module — none is exported.
    from analytics_kit.query import http_adapter

    assert http_adapter._WIRE_RAW_QUERY_KIND == "HogQLQuery"
    assert http_adapter._WIRE_FUNNELS_QUERY_KIND == "FunnelsQuery"
    assert http_adapter._WIRE_BEARER_SCHEME == "Bearer"
    # The confined names are underscore-prefixed (non-public) and absent from any __all__.
    assert not hasattr(http_adapter, "__all__") or "_WIRE_RAW_QUERY_KIND" not in http_adapter.__all__


# --- per-primitive wire→neutral-row contract (mirrors query-contract.fixtures.ts) --------
#
# Each fixture pairs a real insight wire payload with the exact neutral rows the primitive must
# emit; the VALUES mirror the TS query-contract.fixtures.ts cell-for-cell (two casing renames).
# Driving the same fixture through a structured primitive proves the flatten, executably.


def _fixture_run(
    method: str, wire_results: list[object], **envelope_extra: object
) -> QueryResult[Any]:
    """POST a canned immediate envelope carrying `wire_results` through the named primitive."""
    body: dict[str, object] = {"results": wire_results}
    body.update(envelope_extra)
    transport = _CannedTransport([_ok(body)])
    adapter = _adapter(transport)
    if method == "funnel":
        return adapter.funnel(FunnelSpec(steps=["a"], within=Duration(1, "day")))
    if method == "retention":
        return adapter.retention(
            RetentionSpec(cohort_event="a", return_event="b", periods=3, granularity="day")
        )
    if method == "trend":
        return adapter.trend(TrendSpec(event="a", aggregation="total", window=Duration(7, "day")))
    return adapter.unique_count(UniqueCountSpec(event="a", window=Duration(7, "day")))


def test_trend_single_series_flattens_to_neutral_rows() -> None:
    result = _fixture_run("trend", list(trend_single_series.wire_results))
    assert result.rows == trend_single_series.expected_rows
    assert all(isinstance(row, TrendRow) for row in result.rows)


def test_trend_breakdown_flattens_to_one_row_series_per_breakdown() -> None:
    result = _fixture_run("trend", list(trend_breakdown.wire_results))
    assert result.rows == trend_breakdown.expected_rows
    # The breakdown label is stringified onto each row; the engine breakdown_value key is gone.
    assert [row.breakdown for row in result.rows] == ["pro", "pro", "free", "free"]


def test_unique_count_flattens_to_its_own_named_rows() -> None:
    result = _fixture_run("unique_count", list(unique_count_single_series.wire_results))
    assert result.rows == unique_count_single_series.expected_rows
    assert all(isinstance(row, UniqueCountRow) for row in result.rows)


def test_funnel_plain_flattens_with_computed_conversion_rate() -> None:
    result = _fixture_run("funnel", list(funnel_plain.wire_results))
    assert result.rows == funnel_plain.expected_rows
    assert [row.conversion_rate for row in result.rows] == [1, 0.62, 0.41]


def test_funnel_zero_first_step_guards_conversion_rate_to_zero() -> None:
    result = _fixture_run("funnel", list(funnel_zero_first_step.wire_results))
    assert result.rows == funnel_zero_first_step.expected_rows
    assert [row.conversion_rate for row in result.rows] == [0, 0]


def test_funnel_event_precedence_custom_name_then_name_then_action_id() -> None:
    result = _fixture_run("funnel", list(funnel_event_precedence.wire_results))
    assert result.rows == funnel_event_precedence.expected_rows
    # Empty-string custom_name / name are skipped; the first present non-empty wins.
    assert [row.event for row in result.rows] == ["Renamed Step", "order_placed", "act_3"]


def test_funnel_breakdown_array_of_arrays_per_group_conversion_rate() -> None:
    result = _fixture_run("funnel", list(funnel_breakdown.wire_results))
    assert result.rows == funnel_breakdown.expected_rows
    # conversion_rate is per-GROUP (each group's own count[0]); breakdown on every row.
    assert [(row.conversion_rate, row.breakdown) for row in result.rows] == [
        (1, "pro"),
        (0.5, "pro"),
        (1, "free"),
        (0.25, "free"),
    ]


def test_retention_period_index_zero_is_the_cohort() -> None:
    result = _fixture_run("retention", list(retention_cohorts.wire_results))
    assert result.rows == retention_cohorts.expected_rows
    assert [row.period_index for row in result.rows] == [0, 1, 2, 0, 1, 2]


# --- row-level engine-field seal: engine keys absent from the serialized ROWS -------------
#
# Non-vacuous: each seal fixture carries EVERY engine key genuinely on the wire (breakdown_value,
# average_conversion_time, aggregation_value, aggregated_value, converted_people_url). The seal
# serializes the FULL result via model_dump_json() (Pydantic v2 recurses into the frozen-dataclass
# rows) and asserts each engine key appears NOWHERE — paired with a POSITIVE assertion the neutral
# fields surfaced with the right values (including present-null breakdown where not broken down).

_SEAL_TREND_WIRE: list[object] = [
    {
        "label": "order_placed",
        "days": ["2026-07-01", "2026-07-02"],
        "data": [12, 30],
        "count": 42,
        "aggregated_value": 42,
        "aggregation_value": 42,
    },
]
_SEAL_TREND_ROWS = [
    TrendRow(bucket="2026-07-01", value=12),
    TrendRow(bucket="2026-07-02", value=30),
]

_SEAL_TREND_BREAKDOWN_WIRE: list[object] = [
    {
        "breakdown_value": "pro",
        "days": ["2026-07-01"],
        "data": [8],
        "aggregated_value": 8,
    },
]
_SEAL_TREND_BREAKDOWN_ROWS = [TrendRow(bucket="2026-07-01", value=8, breakdown="pro")]

_SEAL_FUNNEL_WIRE: list[object] = [
    {
        "order": 0,
        "name": "signed_up",
        "count": 1000,
        "average_conversion_time": None,
        "converted_people_url": "/people/0",
        "breakdown_value": "pro",
    },
    {
        "order": 1,
        "name": "order_placed",
        "count": 500,
        "average_conversion_time": 3600,
        "converted_people_url": "/people/1",
        "breakdown_value": "pro",
    },
]
_SEAL_FUNNEL_ROWS = [
    FunnelStepRow(step=0, event="signed_up", count=1000, conversion_rate=1, breakdown="pro"),
    FunnelStepRow(step=1, event="order_placed", count=500, conversion_rate=0.5, breakdown="pro"),
]

_SEAL_RETENTION_WIRE: list[object] = [
    {
        "date": "2026-07-01",
        "breakdown_value": "pro",
        "values": [{"count": 500}, {"count": 300}],
    },
]
_SEAL_RETENTION_ROWS = [
    RetentionRow(cohort="2026-07-01", period_index=0, value=500, breakdown="pro"),
    RetentionRow(cohort="2026-07-01", period_index=1, value=300, breakdown="pro"),
]

_SEAL_CASES: list[tuple[str, list[object], list[object]]] = [
    ("trend", _SEAL_TREND_WIRE, list(_SEAL_TREND_ROWS)),
    ("trend", _SEAL_TREND_BREAKDOWN_WIRE, list(_SEAL_TREND_BREAKDOWN_ROWS)),
    ("unique_count", _SEAL_TREND_WIRE, [UniqueCountRow(bucket=r.bucket, value=r.value) for r in _SEAL_TREND_ROWS]),
    ("funnel", _SEAL_FUNNEL_WIRE, list(_SEAL_FUNNEL_ROWS)),
    ("retention", _SEAL_RETENTION_WIRE, list(_SEAL_RETENTION_ROWS)),
]


def _assert_sealed(result: QueryResult[Any], expected_rows: list[object]) -> None:
    # (a) NO engine row field name survives into the serialized rows.
    dumped = result.model_dump_json()
    for engine_field in ENGINE_ROW_FIELD_NAMES:
        assert engine_field not in dumped, f"engine key {engine_field!r} leaked into {dumped}"
    # (b) POSITIVE: the neutral fields surfaced with the expected values (field-and-value equality,
    # NOT TS-style key-absence — breakdown is a present-null str | None field by design).
    assert result.rows == expected_rows


def test_engine_row_fields_are_sealed_out_of_the_immediate_branch() -> None:
    for method, wire, expected in _SEAL_CASES:
        result = _fixture_run(method, list(wire))
        _assert_sealed(result, expected)


def test_engine_row_fields_are_sealed_out_of_the_poll_to_complete_branch() -> None:
    # Sync ≡ async at the row level: the same fixture through the poll-to-complete path yields
    # identically-sealed rows.
    for method, wire, expected in _SEAL_CASES:
        completed = _ok({"query_status": {"id": "q-1", "complete": True, "results": list(wire)}})
        transport = _CannedTransport([_pending(), completed])
        adapter = _adapter(transport)
        if method == "funnel":
            result: QueryResult[Any] = adapter.funnel(FunnelSpec(steps=["a"], within=Duration(1, "day")))
        elif method == "retention":
            result = adapter.retention(
                RetentionSpec(cohort_event="a", return_event="b", periods=3, granularity="day")
            )
        elif method == "trend":
            result = adapter.trend(TrendSpec(event="a", aggregation="total", window=Duration(7, "day")))
        else:
            result = adapter.unique_count(UniqueCountSpec(event="a", window=Duration(7, "day")))
        _assert_sealed(result, expected)


def test_not_broken_down_rows_serialize_breakdown_as_present_null() -> None:
    # The Python row shape difference from TS: breakdown is a defaulted str | None field, so it
    # serializes as present-null ("breakdown": null) when not broken down — the correct honest
    # shape, NOT a leak. Do NOT assert breakdown absent.
    result = _fixture_run("trend", list(trend_single_series.wire_results))
    dumped = json.loads(result.model_dump_json())
    assert all("breakdown" in row and row["breakdown"] is None for row in dumped["rows"])
