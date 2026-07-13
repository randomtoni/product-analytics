"""The HTTP query adapter — the first real query backend, named by ROLE (never a vendor).

Translates each neutral primitive (and ``raw_query``) into the adapter-internal query wire body,
POSTs it to the config-supplied endpoint with Bearer personal-key auth, and — as a SYNCHRONOUS
BLOCKING poll — resolves the response (immediate or async-status) into a Pydantic-decoded neutral
:class:`~analytics_kit.QueryResult`. It is the Python realization of the TS sync-normalize +
async-poll tracks, collapsed into one sync-blocking-poll method: NO asyncio, the always-async HTTP
poll becomes a bounded ``time.sleep``-driven loop (the sync-client posture).

Every wire concern — the query-kind discriminators, the field-casing quirks, the enum vocab, the
endpoint path template, the request posture value, the response-envelope keys, and the ``Bearer``
auth scheme — is sealed in the ``_WIRE_*`` constants (and ``_Wire*`` internal types) below and
NEVER leaves this module. The exported surface (``AnalyticsQueryClient``, the spec types,
``QueryResult``) carries business primitives only; no dialect vocabulary escapes. This is the
highest-neutrality-risk surface in the library (recall the query-kind token that leaked into the
built output in an earlier review) — the ``_WIRE_*`` confinement is what keeps it neutral.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Literal, TypeVar, cast

from ..adapter import DEFAULT_HTTP_TIMEOUT_SECONDS, NeutralResponse
from .client import (
    Aggregation,
    Duration,
    FunnelSpec,
    FunnelStepRow,
    Granularity,
    QueryColumn,
    QueryResult,
    QueryTransport,
    RetentionRow,
    RetentionSpec,
    TrendRow,
    TrendSpec,
    UniqueCountRow,
    UniqueCountSpec,
)
from .config import QueryClientConfig

# --- Wire query-kind discriminators -----------------------------------------------------
#
# Each is a wire value the query endpoint requires verbatim (like an event name on the capture
# wire). Confined to one non-exported constant apiece per the ``_WIRE_*`` discipline — this is the
# exact token class that leaked into the built output in an earlier review, so it stays sealed.
_WIRE_EVENTS_NODE_KIND = "EventsNode"
_WIRE_TRENDS_QUERY_KIND = "TrendsQuery"
_WIRE_FUNNELS_QUERY_KIND = "FunnelsQuery"
_WIRE_RETENTION_QUERY_KIND = "RetentionQuery"
_WIRE_RAW_QUERY_KIND = "HogQLQuery"

# --- Wire request structure keys --------------------------------------------------------
_WIRE_KIND_KEY = "kind"
_WIRE_QUERY_KEY = "query"
_WIRE_REFRESH_KEY = "refresh"
_WIRE_SERIES_KEY = "series"
_WIRE_EVENT_KEY = "event"
_WIRE_MATH_KEY = "math"
_WIRE_INTERVAL_KEY = "interval"
_WIRE_DATE_RANGE_KEY = "dateRange"
_WIRE_DATE_FROM_KEY = "date_from"
_WIRE_BREAKDOWN_FILTER_KEY = "breakdownFilter"
_WIRE_BREAKDOWN_KEY = "breakdown"
_WIRE_BREAKDOWN_TYPE_KEY = "breakdown_type"
_WIRE_BREAKDOWN_TYPE_EVENT = "event"
_WIRE_FUNNELS_FILTER_KEY = "funnelsFilter"
_WIRE_FUNNEL_WINDOW_INTERVAL_KEY = "funnelWindowInterval"
_WIRE_FUNNEL_WINDOW_INTERVAL_UNIT_KEY = "funnelWindowIntervalUnit"
_WIRE_RETENTION_FILTER_KEY = "retentionFilter"
_WIRE_TARGET_ENTITY_KEY = "targetEntity"
_WIRE_RETURNING_ENTITY_KEY = "returningEntity"
_WIRE_PERIOD_KEY = "period"
_WIRE_TOTAL_INTERVALS_KEY = "totalIntervals"
_WIRE_ENTITY_ID_KEY = "id"
_WIRE_ENTITY_NAME_KEY = "name"
_WIRE_ENTITY_TYPE_KEY = "type"
_WIRE_ENTITY_TYPE_EVENTS = "events"

# --- Wire enum vocab --------------------------------------------------------------------
_WireInterval = Literal["hour", "day", "week", "month"]
_WireMath = Literal["total", "dau"]
_WireRetentionPeriod = Literal["Day", "Week", "Month"]

_WIRE_MATH_DAU: _WireMath = "dau"

_INTERVAL_FOR_UNIT: dict[str, _WireInterval] = {
    "minute": "hour",
    "hour": "hour",
    "day": "day",
    "week": "week",
    "month": "month",
}

_MATH_FOR_AGGREGATION: dict[Aggregation, _WireMath] = {
    "total": "total",
    "unique": "dau",
    "dau": "dau",
}

_RETENTION_PERIOD_FOR_GRANULARITY: dict[Granularity, _WireRetentionPeriod] = {
    "day": "Day",
    "week": "Week",
    "month": "Month",
}

_RELATIVE_DATE_UNIT_CHAR: dict[str, str] = {
    "minute": "m",
    "hour": "h",
    "day": "d",
    "week": "w",
    "month": "M",
}

# The request posture: always-async. Every POST carries this value, so the backend runs
# long-window snapshots off-thread and hands back a pollable status; short queries still complete
# inline and take the immediate branch. Adapter-internal config — never on the neutral surface.
_WIRE_REFRESH_ASYNC = "async"

# --- Wire endpoint path -----------------------------------------------------------------
#
# The project-scoped query path appended to the config-supplied host. Wire-shaped, adapter-internal
# — the neutral config carries only ``query_endpoint``/``project_id``, never this template.
def _query_path(project_id: str) -> str:
    return f"/api/projects/{project_id}/query/"


# --- Wire response-envelope keys --------------------------------------------------------
_WIRE_RESULTS_KEY = "results"
_WIRE_COLUMNS_KEY = "columns"
_WIRE_TYPES_KEY = "types"
_WIRE_IS_CACHED_KEY = "is_cached"
_WIRE_QUERY_STATUS_KEY = "query_status"
_WIRE_STATUS_ID_KEY = "id"
_WIRE_COMPLETE_KEY = "complete"
_WIRE_ERROR_KEY = "error"

# --- Wire per-primitive insight result keys ---------------------------------------------
#
# The engine-internal field names inside each structured primitive's ``results`` entries. Consumed
# INSIDE the per-primitive builders and NEVER surfaced onto a neutral row — the row-level neutrality
# seal. (``breakdown_value`` in particular is the engine key the columns-absent pass-through leaked.)
_WIRE_DAYS_KEY = "days"
_WIRE_DATA_KEY = "data"
_WIRE_BREAKDOWN_VALUE_KEY = "breakdown_value"
_WIRE_ORDER_KEY = "order"
_WIRE_COUNT_KEY = "count"
_WIRE_CUSTOM_NAME_KEY = "custom_name"
_WIRE_ACTION_ID_KEY = "action_id"
_WIRE_DATE_KEY = "date"
_WIRE_VALUES_KEY = "values"

# --- Wire auth --------------------------------------------------------------------------
_WIRE_AUTHORIZATION_HEADER = "Authorization"
_WIRE_BEARER_SCHEME = "Bearer"
_WIRE_CONTENT_TYPE_HEADER = "Content-Type"
_WIRE_CONTENT_TYPE_JSON = "application/json"
_WIRE_METHOD_POST = "POST"
_WIRE_METHOD_GET = "GET"

_STATUS_OK_FLOOR = 200
_STATUS_OK_CEIL = 300

# --- Bounded backoff-aware poll budget --------------------------------------------------
#
# A query POLL (waiting for a long-running query to finish) is a distinct concern from a transport
# RETRY, so its bounded budget lives here (de-branded from the TS constants). The loop is ALWAYS
# bounded — never an infinite wait on a query that does not complete.
POLL_BASE_S = 0.25
POLL_MAX_DELAY_S = 5.0
POLL_MAX_ATTEMPTS = 20


def _poll_delay(attempt: int) -> float:
    delay: float = POLL_BASE_S * 2**attempt
    return min(POLL_MAX_DELAY_S, delay)


Wait = Callable[[float], None]
"""The blocking poll wait, injectable so poll tests short-circuit it instead of sleeping."""


class _QueryError(Exception):
    """The neutral query failure — a normalized error, carrying no wire/vendor detail.

    Every failure at the query boundary (a non-OK status, a raised transport exception, a wire
    ``error`` flag, attempts exhausted) surfaces as this one neutral type. The raw HTTP status, the
    vendor error body, and the underlying transport exception are all swallowed here — none reaches
    the neutral surface.
    """


class _UrllibQueryTransport:
    """The default query transport — a stdlib ``urllib`` request (zero new dependency).

    Typed against :class:`~analytics_kit.QueryTransport` (structurally), so no ``urllib`` handle
    crosses the seam: it returns only the neutral :class:`~analytics_kit.NeutralResponse`. Supplied
    by the adapter when the consumer injects no transport.
    """

    def send(
        self,
        url: str,
        method: str,
        headers: dict[str, str],
        body: str | None = None,
    ) -> NeutralResponse:
        data = body.encode("utf-8") if body is not None else None
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=DEFAULT_HTTP_TIMEOUT_SECONDS) as response:  # noqa: S310
                return NeutralResponse(status=response.status, body=response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            # urllib RAISES on non-2xx; return the real status so ``_post``'s status check classifies
            # it (a non-OK status → neutral query error) rather than the blanket except doing so.
            return NeutralResponse(status=error.code, body=error.read().decode("utf-8", errors="replace"))


def _breakdown_filter(breakdown: str | None) -> dict[str, object] | None:
    if breakdown is None:
        return None
    return {
        _WIRE_BREAKDOWN_KEY: breakdown,
        _WIRE_BREAKDOWN_TYPE_KEY: _WIRE_BREAKDOWN_TYPE_EVENT,
    }


def _events_node(event: str, math: _WireMath | None = None) -> dict[str, object]:
    node: dict[str, object] = {_WIRE_KIND_KEY: _WIRE_EVENTS_NODE_KIND, _WIRE_EVENT_KEY: event}
    if math is not None:
        node[_WIRE_MATH_KEY] = math
    return node


def _retention_entity(event: str) -> dict[str, object]:
    return {
        _WIRE_ENTITY_ID_KEY: event,
        _WIRE_ENTITY_NAME_KEY: event,
        _WIRE_ENTITY_TYPE_KEY: _WIRE_ENTITY_TYPE_EVENTS,
        _WIRE_KIND_KEY: _WIRE_EVENTS_NODE_KIND,
    }


def _relative_date_from(window: Duration) -> str:
    return f"-{window.value}{_RELATIVE_DATE_UNIT_CHAR[window.unit]}"


def _with_breakdown(query: dict[str, object], breakdown: str | None) -> dict[str, object]:
    filter_ = _breakdown_filter(breakdown)
    if filter_ is not None:
        query[_WIRE_BREAKDOWN_FILTER_KEY] = filter_
    return query


def _is_ok(status: int) -> bool:
    return _STATUS_OK_FLOOR <= status < _STATUS_OK_CEIL


_TRow = TypeVar("_TRow")
RowBuilder = Callable[[list[object]], "list[_TRow]"]
"""A per-primitive row builder: maps the untrusted ``results`` list into the primitive's rows.

The SHARED envelope handling (the ``results`` list guard, the ``columns``/``generated_at``/
``from_cache`` assembly, the neutral did-not-complete error) stays in :func:`_normalize_result`;
only the row-building step is per-primitive, threaded down through ``_run``/``_poll_to_completion``/
``_result_from_status`` so sync and async completion sinks yield identical rows. A ``None`` builder
is ``raw_query``'s pre-per-primitive verbatim pass-through (columns-present zip / columns-absent
object pass-through); the four structured primitives pass their flattening builder and IGNORE columns.
"""


def _normalize_result(
    source: dict[str, object],
    from_cache: bool | None,
    row_builder: RowBuilder[_TRow] | None,
) -> QueryResult[_TRow]:
    """Normalize a result-bearing wire object into the neutral :class:`QueryResult`.

    Takes the result-bearing object (NOT the full envelope), so the completed-poll path reuses it
    on the nested ``query_status`` payload unchanged. The shared envelope scaffolding lives here in
    ONE place across every primitive — the ``results`` list guard, the ``generated_at``/
    ``from_cache`` assembly. The ROW-building step is per-primitive:

    * ``row_builder is None`` — ``raw_query``'s verbatim pass-through: when the column list is
      present the rows are cell-arrays zipped into keyed objects (the consumer's own SELECT
      projection, already neutral); when absent the entries are result objects and pass through as
      records. This is the ONE primitive that consults ``columns`` — the sole dialect-keyed surface.
    * ``row_builder`` supplied — one of the four structured flatteners, which read only ``results``
      and IGNORE ``columns`` entirely (a real insight response carries none; the result is built
      with ``columns=[]`` so a spurious wire ``columns`` array can never re-surface engine column
      names — that would reopen the leak).

    ``results`` is required on a well-formed envelope, but the JSON is untrusted — a completed/
    zero-row envelope missing it surfaces as a neutral error, never a raw ``KeyError``/``TypeError``.
    """
    raw_results = source.get(_WIRE_RESULTS_KEY)
    if not isinstance(raw_results, list):
        raise _QueryError("analytics-kit: query did not complete")

    if row_builder is None:
        columns = _columns_of(source)
        # ``raw_query``'s rows are raw wire records — decoded through ``model_validate`` (the
        # untrusted-wire boundary), unchanged from the pre-per-primitive behavior.
        raw_rows: list[object] = (
            [_zip_row(row, columns) for row in raw_results]
            if columns
            else [entry for entry in raw_results if isinstance(entry, dict)]
        )
        payload: dict[str, object] = {
            "rows": raw_rows,
            "columns": columns,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
        if from_cache is not None:
            payload["from_cache"] = from_cache
        return cast("QueryResult[_TRow]", QueryResult.model_validate(payload))

    # The four structured primitives build already-trusted frozen-dataclass rows here (not decoded
    # from wire), so the generic ``QueryResult`` is CONSTRUCTED DIRECTLY — no re-validation round-trip
    # — with ``columns=[]`` (a structured insight response carries no ``columns``).
    rows = row_builder(raw_results)
    return QueryResult[_TRow](
        rows=rows,
        columns=[],
        generated_at=datetime.now(timezone.utc).isoformat(),
        from_cache=from_cache,
    )


def _columns_of(source: dict[str, object]) -> list[QueryColumn]:
    """The parallel ``columns``/``types`` schema — read by ``raw_query`` only.

    The four structured builders IGNORE this and their result is built with ``columns=[]``: a real
    trend/funnel/retention insight response carries no ``columns``/``types``, so letting a structured
    row-builder key off them would reopen the leak (a spurious wire ``columns`` array re-surfacing
    the engine column names on ``result.columns``).
    """
    raw_columns = source.get(_WIRE_COLUMNS_KEY)
    raw_types = source.get(_WIRE_TYPES_KEY)
    column_names = raw_columns if isinstance(raw_columns, list) else []
    type_names = raw_types if isinstance(raw_types, list) else []

    columns: list[QueryColumn] = []
    for i, name in enumerate(column_names):
        col_type = type_names[i] if i < len(type_names) else None
        columns.append(QueryColumn(name=str(name), type=str(col_type) if col_type is not None else None))
    return columns


def _zip_row(row: object, columns: list[QueryColumn]) -> dict[str, object]:
    if isinstance(row, list):
        return {column.name: row[i] if i < len(row) else None for i, column in enumerate(columns)}
    if isinstance(row, dict):
        return row
    return {}


def _optional_breakdown(value: object) -> str | None:
    """The wire ``breakdown_value`` is engine-internal — surface as neutral ``breakdown`` only when
    present, stringified, and never as a raw key on the row."""
    return None if value is None else str(value)


# De-branded from posthog's trends result.
def _build_trend_rows(raw_results: list[object]) -> list[TrendRow]:
    """Each ``results`` entry carries positionally-parallel ``days: str[]`` (ISO bucket dates) and
    ``data: number[]`` (one value per bucket), flattened to one neutral row per index.
    ``unique_count`` is byte-identical on the wire (same shape, only server-side math differs) — it
    uses :func:`_build_unique_count_rows`, a thin wrapper over the same walk. With a breakdown the
    backend returns one top-level entry per breakdown value, each with its own ``days``/``data`` +
    ``breakdown_value`` (stringified onto ``breakdown``).
    """
    rows: list[TrendRow] = []
    for entry in raw_results:
        if not isinstance(entry, dict):
            continue
        days = entry.get(_WIRE_DAYS_KEY)
        data = entry.get(_WIRE_DATA_KEY)
        if not isinstance(days, list) or not isinstance(data, list):
            continue
        breakdown = _optional_breakdown(entry.get(_WIRE_BREAKDOWN_VALUE_KEY))
        for i, bucket in enumerate(days):
            value = data[i] if i < len(data) else None
            if not isinstance(bucket, str) or not isinstance(value, (int, float)) or isinstance(value, bool):
                continue
            rows.append(TrendRow(bucket=bucket, value=value, breakdown=breakdown))
    return rows


def _build_unique_count_rows(raw_results: list[object]) -> list[UniqueCountRow]:
    """Same wire walk as :func:`_build_trend_rows`, constructing the OWN-named :class:`UniqueCountRow`
    (unique-count keeps its own row identity even though the fields coincide)."""
    return [
        UniqueCountRow(bucket=row.bucket, value=row.value, breakdown=row.breakdown)
        for row in _build_trend_rows(raw_results)
    ]


def _funnel_event(step: dict[str, object]) -> str | None:
    for key in (_WIRE_CUSTOM_NAME_KEY, _WIRE_ENTITY_NAME_KEY, _WIRE_ACTION_ID_KEY):
        value = step.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _first_step_count(steps: list[object]) -> float:
    for step in steps:
        if isinstance(step, dict) and step.get(_WIRE_ORDER_KEY) == 0:
            count = step.get(_WIRE_COUNT_KEY)
            if isinstance(count, (int, float)) and not isinstance(count, bool):
                return count
    first = steps[0] if steps else None
    if isinstance(first, dict):
        count = first.get(_WIRE_COUNT_KEY)
        if isinstance(count, (int, float)) and not isinstance(count, bool):
            return count
    return 0


def _funnel_group_rows(steps: list[object]) -> list[FunnelStepRow]:
    first_count = _first_step_count(steps)
    out: list[FunnelStepRow] = []
    for step in steps:
        if not isinstance(step, dict):
            continue
        order = step.get(_WIRE_ORDER_KEY)
        count = step.get(_WIRE_COUNT_KEY)
        if not isinstance(order, int) or isinstance(order, bool):
            continue
        if not isinstance(count, int) or isinstance(count, bool):
            continue
        event = _funnel_event(step)
        if event is None:
            continue
        conversion_rate = 0.0 if first_count == 0 else count / first_count
        breakdown = _optional_breakdown(step.get(_WIRE_BREAKDOWN_VALUE_KEY))
        out.append(
            FunnelStepRow(
                step=order,
                event=event,
                count=count,
                conversion_rate=conversion_rate,
                breakdown=breakdown,
            )
        )
    return out


# De-branded from posthog's funnel result.
def _build_funnel_rows(raw_results: list[object]) -> list[FunnelStepRow]:
    """``results`` is per-step objects (an array-of-arrays when broken down — the outer layer is
    unwrapped per breakdown group). Each step carries ``order`` (0-based index), ``count``, and
    ``custom_name``/``name``/``action_id`` for the event identity. ``conversion_rate`` is NOT a wire
    field — COMPUTED as ``count[step] / count[0]`` (overall conversion from the first step, guarded
    ``count[0] == 0 -> 0.0`` to avoid a ``ZeroDivisionError``).
    """
    rows: list[FunnelStepRow] = []
    for group in raw_results:
        if isinstance(group, list):
            rows.extend(_funnel_group_rows(group))
        else:
            rows.extend(_funnel_group_rows(raw_results))
            break
    return rows


# De-branded from posthog's retention result.
def _build_retention_rows(raw_results: list[object]) -> list[RetentionRow]:
    """``results`` is cohort objects, each with ``date`` (the cohort start, ISO) and
    ``values: [{ count }]`` where the array index is the period (0 = the cohort itself). Double loop:
    one neutral row per (cohort, period) cell; ``breakdown`` from the cohort's ``breakdown_value``
    when present.
    """
    rows: list[RetentionRow] = []
    for cohort in raw_results:
        if not isinstance(cohort, dict):
            continue
        date = cohort.get(_WIRE_DATE_KEY)
        values = cohort.get(_WIRE_VALUES_KEY)
        if not isinstance(date, str) or not isinstance(values, list):
            continue
        breakdown = _optional_breakdown(cohort.get(_WIRE_BREAKDOWN_VALUE_KEY))
        for j, cell in enumerate(values):
            if not isinstance(cell, dict):
                continue
            count = cell.get(_WIRE_COUNT_KEY)
            if not isinstance(count, (int, float)) or isinstance(count, bool):
                continue
            rows.append(RetentionRow(cohort=date, period_index=j, value=count, breakdown=breakdown))
    return rows


class HttpQueryAdapter:
    """The HTTP query backend satisfying :class:`~analytics_kit.AnalyticsQueryClient`.

    Each primitive translates its spec into the adapter-internal query wire body, POSTs it with
    Bearer personal-key auth to the config endpoint, and resolves the response synchronously: an
    immediate-result envelope is normalized and returned; an async-status envelope (not yet
    complete) is polled with a bounded, backoff-delayed BLOCKING wait until it completes, then
    normalized. NO asyncio — one synchronous method blocks until the result is ready. A transport
    failure (non-OK status or a raised exception) is normalized to a neutral error at the boundary;
    no raw HTTP/vendor detail escapes.
    """

    def __init__(
        self,
        *,
        query_endpoint: str,
        personal_key: str,
        project_id: str,
        transport: QueryTransport | None = None,
        wait: Wait | None = None,
    ) -> None:
        host = query_endpoint.rstrip("/")
        self._url = f"{host}{_query_path(project_id)}"
        self._personal_key = personal_key
        self._transport: QueryTransport = transport if transport is not None else _UrllibQueryTransport()
        self._wait: Wait = wait if wait is not None else time.sleep

    def funnel(self, spec: FunnelSpec) -> QueryResult[FunnelStepRow]:
        query: dict[str, object] = {
            _WIRE_KIND_KEY: _WIRE_FUNNELS_QUERY_KIND,
            _WIRE_SERIES_KEY: [_events_node(step) for step in spec.steps],
            _WIRE_FUNNELS_FILTER_KEY: {
                _WIRE_FUNNEL_WINDOW_INTERVAL_KEY: spec.within.value,
                _WIRE_FUNNEL_WINDOW_INTERVAL_UNIT_KEY: spec.within.unit,
            },
        }
        return self._run(_with_breakdown(query, spec.breakdown), _build_funnel_rows)

    def retention(self, spec: RetentionSpec) -> QueryResult[RetentionRow]:
        query: dict[str, object] = {
            _WIRE_KIND_KEY: _WIRE_RETENTION_QUERY_KIND,
            _WIRE_RETENTION_FILTER_KEY: {
                _WIRE_TARGET_ENTITY_KEY: _retention_entity(spec.cohort_event),
                _WIRE_RETURNING_ENTITY_KEY: _retention_entity(spec.return_event),
                _WIRE_PERIOD_KEY: _RETENTION_PERIOD_FOR_GRANULARITY[spec.granularity],
                _WIRE_TOTAL_INTERVALS_KEY: spec.periods,
            },
        }
        return self._run(_with_breakdown(query, spec.breakdown), _build_retention_rows)

    def trend(self, spec: TrendSpec) -> QueryResult[TrendRow]:
        query: dict[str, object] = {
            _WIRE_KIND_KEY: _WIRE_TRENDS_QUERY_KIND,
            _WIRE_SERIES_KEY: [_events_node(spec.event, _MATH_FOR_AGGREGATION[spec.aggregation])],
            _WIRE_INTERVAL_KEY: _INTERVAL_FOR_UNIT[spec.window.unit],
            _WIRE_DATE_RANGE_KEY: {_WIRE_DATE_FROM_KEY: _relative_date_from(spec.window)},
        }
        return self._run(_with_breakdown(query, spec.breakdown), _build_trend_rows)

    def unique_count(self, spec: UniqueCountSpec) -> QueryResult[UniqueCountRow]:
        query: dict[str, object] = {
            _WIRE_KIND_KEY: _WIRE_TRENDS_QUERY_KIND,
            _WIRE_SERIES_KEY: [_events_node(spec.event, _WIRE_MATH_DAU)],
            _WIRE_INTERVAL_KEY: _INTERVAL_FOR_UNIT[spec.window.unit],
            _WIRE_DATE_RANGE_KEY: {_WIRE_DATE_FROM_KEY: _relative_date_from(spec.window)},
        }
        return self._run(_with_breakdown(query, spec.breakdown), _build_unique_count_rows)

    def raw_query(self, expr: str) -> QueryResult:
        return self._run({_WIRE_KIND_KEY: _WIRE_RAW_QUERY_KIND, _WIRE_QUERY_KEY: expr}, None)

    def _headers(self) -> dict[str, str]:
        return {
            _WIRE_AUTHORIZATION_HEADER: f"{_WIRE_BEARER_SCHEME} {self._personal_key}",
            _WIRE_CONTENT_TYPE_HEADER: _WIRE_CONTENT_TYPE_JSON,
        }

    def _post(self, url: str, method: str, body: str | None) -> dict[str, object]:
        """Send one request, normalizing every failure to a neutral error at the boundary.

        A raised transport exception (connection/timeout/DNS/any HTTP-client error) is caught here;
        a non-OK status raises a neutral error; a non-object/malformed body raises a neutral error.
        No raw HTTP/vendor exception or error-body shape crosses onto the neutral surface.
        """
        try:
            response = self._transport.send(url, method, self._headers(), body)
        except _QueryError:
            raise
        except Exception as exc:  # noqa: BLE001 — normalize ANY transport failure at the boundary.
            raise _QueryError("analytics-kit: query request failed") from exc
        if not _is_ok(response.status):
            raise _QueryError("analytics-kit: query request failed")
        try:
            decoded = json.loads(response.body)
        except (ValueError, TypeError) as exc:
            raise _QueryError("analytics-kit: query request failed") from exc
        if not isinstance(decoded, dict):
            raise _QueryError("analytics-kit: query request failed")
        return decoded

    def _run(self, query: dict[str, object], row_builder: RowBuilder[_TRow] | None) -> QueryResult[_TRow]:
        body = json.dumps({_WIRE_QUERY_KEY: query, _WIRE_REFRESH_KEY: _WIRE_REFRESH_ASYNC})
        envelope = self._post(self._url, _WIRE_METHOD_POST, body)

        status = envelope.get(_WIRE_QUERY_STATUS_KEY)
        # Async when the backend accepted the query off-thread: a status envelope that is NOT yet
        # complete. Detection keys on ``complete != True``, NEVER on mere presence of the status
        # key — the COMPLETED poll response still carries that key, so presence-detection would
        # loop forever on a done query. The per-primitive ``row_builder`` threads through every
        # completion sink so an inline result and a polled one yield identical neutral rows.
        if isinstance(status, dict) and status.get(_WIRE_COMPLETE_KEY) is not True:
            return self._poll_to_completion(status, row_builder)
        if isinstance(status, dict):
            return self._result_from_status(status, row_builder)

        from_cache = envelope.get(_WIRE_IS_CACHED_KEY)
        return _normalize_result(envelope, from_cache if isinstance(from_cache, bool) else None, row_builder)

    def _poll_to_completion(
        self, initial: dict[str, object], row_builder: RowBuilder[_TRow] | None
    ) -> QueryResult[_TRow]:
        """Block on an incomplete async status until it completes — a BOUNDED loop, never infinite.

        Terminal on ``complete == True`` (normalize the nested status payload), a wire ``error``
        flag (neutral error), or attempts exhausted (neutral "did not complete" error). Between
        polls it blocks with the injected ``wait`` and a bounded exponential backoff, so a
        never-completing query gives up after ``POLL_MAX_ATTEMPTS`` rather than hanging.
        """
        status_id = initial.get(_WIRE_STATUS_ID_KEY)
        if not isinstance(status_id, str):
            raise _QueryError("analytics-kit: query did not complete")
        poll_url = f"{self._url}{status_id}/"

        for attempt in range(POLL_MAX_ATTEMPTS):
            self._wait(_poll_delay(attempt))
            envelope = self._post(poll_url, _WIRE_METHOD_GET, None)
            status = envelope.get(_WIRE_QUERY_STATUS_KEY)
            if not isinstance(status, dict):
                raise _QueryError("analytics-kit: query did not complete")
            # Short-circuit a backend that reports failure before completing — otherwise an
            # ``error: true, complete: false`` status would poll the whole budget before failing.
            if status.get(_WIRE_ERROR_KEY) is True:
                raise _QueryError("analytics-kit: query did not complete")
            if status.get(_WIRE_COMPLETE_KEY) is True:
                return self._result_from_status(status, row_builder)
        raise _QueryError("analytics-kit: query did not complete")

    def _result_from_status(
        self, status: dict[str, object], row_builder: RowBuilder[_TRow] | None
    ) -> QueryResult[_TRow]:
        """Turn a completed status envelope into the neutral result, or surface its failure.

        Reuses the SAME normalizer AND the SAME per-primitive ``row_builder`` as the immediate path
        on the nested ``query_status`` payload, so a result that arrives via poll flattens to the
        identical neutral rows as one that arrives inline.
        """
        if status.get(_WIRE_ERROR_KEY) is True:
            raise _QueryError("analytics-kit: query did not complete")
        from_cache = status.get(_WIRE_IS_CACHED_KEY)
        return _normalize_result(status, from_cache if isinstance(from_cache, bool) else None, row_builder)


def create_http_query_adapter(config: QueryClientConfig, *, wait: Wait | None = None) -> HttpQueryAdapter:
    """Build the HTTP query adapter from a keyed + endpointed :class:`QueryClientConfig`.

    Reached only via ``create_query_client`` once ``personal_key`` + ``query_endpoint`` are set, so
    both are present here (an unset endpoint/key is the no-op's branch, upstream). ``project_id``
    defaults to the empty scope when unset. ``wait`` is injectable purely so the poll is drivable
    without a real sleep under test.
    """
    return HttpQueryAdapter(
        query_endpoint=config.query_endpoint or "",
        personal_key=config.personal_key or "",
        project_id=config.project_id or "",
        transport=config.transport,
        wait=wait,
    )
