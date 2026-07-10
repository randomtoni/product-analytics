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
    NeutralResponse,
    QueryClientConfig,
    QueryResult,
    RetentionSpec,
    TrendSpec,
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
    transport = _CannedTransport([_immediate()])
    result = _adapter(transport).funnel(FunnelSpec(steps=["a"], within=Duration(1, "day")))
    assert isinstance(result, QueryResult)
    assert result.rows == [{"a": 1, "b": 2}]
    assert [c.name for c in result.columns] == ["a", "b"]
    assert [c.type for c in result.columns] == ["int", "int"]
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
    status: dict[str, object] = {"id": "q-1", "complete": True, "results": [[9]], "columns": ["n"]}
    status.update(extra)
    return _ok({"query_status": status})


def test_async_status_is_polled_until_complete_then_normalized() -> None:
    transport = _CannedTransport([_pending(), _pending(), _complete()])
    result = _adapter(transport).trend(
        TrendSpec(event="e", aggregation="total", window=Duration(7, "day"))
    )
    assert result.rows == [{"n": 9}]
    # POST submit + two GET polls (second returns complete).
    assert transport.sends[0].method == "POST"
    assert transport.sends[1].method == "GET"
    assert transport.sends[1].url == "https://query.example/api/projects/42/query/q-1/"


def test_immediate_result_returns_without_polling() -> None:
    transport = _CannedTransport([_immediate()])
    _adapter(transport).raw_query("q")
    assert len(transport.sends) == 1  # POST only, no poll GET


def test_a_completed_status_in_the_post_response_does_not_poll() -> None:
    # The async-detection foot-gun: a completed poll STILL carries query_status. Keying on
    # presence would loop forever; keying on complete != True resolves immediately.
    transport = _CannedTransport([_complete()])
    result = _adapter(transport).raw_query("q")
    assert result.rows == [{"n": 9}]
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


def test_a_completed_status_without_a_status_id_on_first_poll_is_neutral_error() -> None:
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
