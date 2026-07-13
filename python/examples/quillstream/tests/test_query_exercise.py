"""Query exercise: the four read primitives through a fake transport (PY5 surface).

Quillstream wires a ``QueryClientConfig`` with BOTH ``personal_key`` AND ``query_endpoint`` set
(so ``create_query_client`` selects the real HTTP adapter, not the silent no-op — the query
footgun the story pins) and injects a ``FakeQueryTransport`` that returns a canned wire body
decoding into a populated ``QueryResult``. Each of funnel / retention / trend / unique_count is
run and asserted to return the flat ``QueryResult`` shape a snapshot job expects
(``rows`` / ``columns`` / ``generated_at`` / ``from_cache``). No socket is ever opened.

The fake stands in for the backend, so — like the locked TS contract's mock transport — it may
read the request's wire ``kind`` to pick a shape-appropriate canned row set. That coupling lives
only in this test double; the ASSERTIONS stay on the neutral flat ``QueryResult`` surface.
"""

from __future__ import annotations

import json

from typing_extensions import TypeVar

from analytics_kit import (
    AnalyticsQueryClient,
    Duration,
    FunnelSpec,
    FunnelStepRow,
    NeutralResponse,
    QueryClientConfig,
    QueryResult,
    RetentionRow,
    RetentionSpec,
    TrendRow,
    TrendSpec,
    UniqueCountRow,
    UniqueCountSpec,
    create_query_client,
)

_TRow = TypeVar("_TRow")

# Real structured-insight wire shapes (the columns-ABSENT branch a structured primitive actually
# receives): funnel per-step objects, retention cohort objects with an indexed values array, trend
# parallel days/data. A structured primitive NEVER receives a columns-present cell-array — the
# adapter flattens these into the neutral rows a snapshot job reads.
_WIRE_BY_KIND: dict[str, dict[str, object]] = {
    "FunnelsQuery": {
        "results": [
            {"order": 0, "name": "workspace_created", "count": 1000},
            {"order": 1, "name": "document_created", "count": 620},
            {"order": 2, "name": "document_published", "count": 410},
        ],
        "is_cached": False,
    },
    "RetentionQuery": {
        "results": [
            {"date": "2026-07-01", "values": [{"count": 500}, {"count": 310}, {"count": 190}]},
        ],
        "is_cached": False,
    },
    "TrendsQuery": {
        "results": [
            {"days": ["2026-07-01", "2026-07-02"], "data": [42, 55]},
        ],
        "is_cached": True,
    },
}


class FakeQueryTransport:
    """A recording query transport standing in for the backend — satisfies ``QueryTransport``.

    ``send`` records each request and returns a ``NeutralResponse(status=200, body=<JSON>)`` whose
    body is the sync (``query_status``-less) envelope the HTTP adapter's normalizer decodes into a
    ``QueryResult``. It reads the request's wire ``kind`` — a backend concern the double emulates —
    to return a shape-appropriate row set. Never opens a socket.
    """

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def send(
        self,
        url: str,
        method: str,
        headers: dict[str, str],
        body: str | None = None,
    ) -> NeutralResponse:
        self.calls.append((url, method))
        kind = self._kind_of(body)
        wire = _WIRE_BY_KIND.get(kind, _WIRE_BY_KIND["TrendsQuery"])
        return NeutralResponse(status=200, body=json.dumps(wire))

    @staticmethod
    def _kind_of(body: str | None) -> str:
        if body is None:
            return ""
        decoded = json.loads(body)
        query = decoded.get("query", {})
        kind = query.get("kind", "")
        return kind if isinstance(kind, str) else ""


def _keyed_client(transport: FakeQueryTransport) -> AnalyticsQueryClient:
    config = QueryClientConfig(
        personal_key="quillstream-read-key",
        query_endpoint="https://analytics.quillstream.example",
        project_id="quillstream-prod",
        transport=transport,
    )
    return create_query_client(config)


def _assert_well_formed(result: QueryResult[_TRow]) -> None:
    assert isinstance(result.rows, list)
    assert isinstance(result.columns, list)
    assert isinstance(result.generated_at, str)
    assert result.generated_at != ""


def test_keyed_and_endpointed_config_selects_the_real_adapter_and_consults_the_transport() -> None:
    transport = FakeQueryTransport()
    client = _keyed_client(transport)

    client.funnel(FunnelSpec(steps=["workspace_created", "document_created"], within=Duration(7, "day")))

    # The real HTTP adapter branch was selected (both key + endpoint set), so the injected
    # transport was consulted — proving these assertions are NOT the vacuous QueryNoop path.
    assert len(transport.calls) == 1
    url, method = transport.calls[0]
    assert url == "https://analytics.quillstream.example/api/projects/quillstream-prod/query/"
    assert method == "POST"


def test_funnel_normalizes_to_a_flat_query_result() -> None:
    transport = FakeQueryTransport()
    result = _keyed_client(transport).funnel(
        FunnelSpec(steps=["workspace_created", "document_created", "document_published"], within=Duration(7, "day"))
    )

    _assert_well_formed(result)
    # A structured insight carries no columns — the adapter flattens per-step objects into the
    # neutral FunnelStepRows a snapshot job reads (conversion_rate computed off the first step).
    assert result.columns == []
    assert result.rows == [
        FunnelStepRow(step=0, event="workspace_created", count=1000, conversion_rate=1),
        FunnelStepRow(step=1, event="document_created", count=620, conversion_rate=0.62),
        FunnelStepRow(step=2, event="document_published", count=410, conversion_rate=0.41),
    ]
    assert result.from_cache is False


def test_retention_normalizes_to_a_flat_query_result() -> None:
    transport = FakeQueryTransport()
    result = _keyed_client(transport).retention(
        RetentionSpec(
            cohort_event="workspace_created",
            return_event="document_created",
            periods=8,
            granularity="week",
        )
    )

    _assert_well_formed(result)
    assert result.columns == []
    assert result.rows == [
        RetentionRow(cohort="2026-07-01", period_index=0, value=500),
        RetentionRow(cohort="2026-07-01", period_index=1, value=310),
        RetentionRow(cohort="2026-07-01", period_index=2, value=190),
    ]


def test_trend_normalizes_to_a_flat_query_result() -> None:
    transport = FakeQueryTransport()
    result = _keyed_client(transport).trend(
        TrendSpec(event="draft_saved", aggregation="total", window=Duration(30, "day"))
    )

    _assert_well_formed(result)
    assert result.columns == []
    assert result.rows == [
        TrendRow(bucket="2026-07-01", value=42),
        TrendRow(bucket="2026-07-02", value=55),
    ]
    # The trend canned body flags a cached response — the optional wire flag decodes onto the seam.
    assert result.from_cache is True


def test_unique_count_normalizes_to_a_flat_query_result() -> None:
    # unique_count rides the trends wire node, so it decodes the same shape a snapshot job reads.
    transport = FakeQueryTransport()
    result = _keyed_client(transport).unique_count(
        UniqueCountSpec(event="comment_posted", window=Duration(30, "day"))
    )

    _assert_well_formed(result)
    assert result.columns == []
    assert result.rows == [
        UniqueCountRow(bucket="2026-07-01", value=42),
        UniqueCountRow(bucket="2026-07-02", value=55),
    ]


def test_endpointless_config_is_the_query_footgun_no_op() -> None:
    # The footgun the story pins: drop query_endpoint and the factory returns the silent
    # QueryNoop — the shape assertions would then pass vacuously on an empty result and the
    # injected transport is never consulted. Proven here so a future config mistake is caught.
    transport = FakeQueryTransport()
    config = QueryClientConfig(personal_key="quillstream-read-key", transport=transport)
    result = create_query_client(config).funnel(
        FunnelSpec(steps=["workspace_created"], within=Duration(7, "day"))
    )

    _assert_well_formed(result)
    assert result.rows == []
    assert result.columns == []
    assert transport.calls == []
