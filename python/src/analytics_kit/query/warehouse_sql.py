"""The warehouse SQL-generation module — pure builders + the shared result assembler.

Emits Postgres SQL as **strings only** over the E17 taxonomy-generated typed VIEW
(:data:`~analytics_kit.query.warehouse_schema.EVENTS_VIEW`), plus the shared assembler that
normalizes a driver's :class:`~analytics_kit.query.db_execute.DbExecuteResult` into the neutral
:class:`~analytics_kit.QueryResult`. Imports no database driver and executes nothing — a caller
routes the emitted SQL through the injected :class:`~analytics_kit.query.db_execute.DbExecute` seam.
The trend/unique_count builder is the first resident; funnel/retention/raw builders (S2–S4) join it.

Never targets the base ``events`` table and never reads ``properties`` directly — breakdown groups
on the typed view column projected for the breakdown key (``("<key>")::text``), so every query body
selects only view columns.

Parity is by shared contract, not shared code: the emitted SQL is Postgres (language-agnostic) and
**byte-identical** to the TypeScript ``warehouse-sql.ts`` for the same spec; only the surrounding
builder code is cased idiomatically.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from typing import Callable, Mapping, TypeVar

from ..taxonomy import PropDecl
from .client import (
    Aggregation,
    Duration,
    FunnelSpec,
    FunnelStepRow,
    Granularity,
    QueryColumn,
    QueryResult,
    RetentionRow,
    RetentionSpec,
    TrendRow,
    TrendSpec,
    UniqueCountSpec,
)
from .db_execute import DbColumn, DbExecuteResult
from .warehouse_schema import EVENTS_VIEW, _collect_projection_keys, _quote_ident

__all__ = [
    "WarehouseQuery",
    "WarehouseRowBuilder",
    "build_trend_sql",
    "build_unique_count_sql",
    "build_funnel_sql",
    "build_retention_sql",
    "build_trend_rows",
    "build_funnel_rows",
    "build_retention_rows",
    "build_raw_rows",
    "assemble_result",
    "collect_declarable_keys",
]

_TRow = TypeVar("_TRow")


def _breakdown_column(breakdown: str) -> str:
    """The breakdown leaf: the typed view column projected for ``breakdown``, TEXT-CAST.

    ``_quote_ident`` (shared with the view generator, so the alias here IS the projected column)
    yields ``"<key>"``; the ``::text`` cast makes Postgres — not the client driver — render the
    neutral breakdown string, so a non-string declared prop (``number``/``boolean``) renders the
    SAME canonical string cross-tree. The view ALWAYS projects a column for a declared key, so this
    references it; an undeclared key never reaches here (it raises at :func:`_require_declared`).
    """
    return f"({_quote_ident(breakdown)})::text"


def _require_declared(breakdown: str, declarable_keys: frozenset[str] | None) -> None:
    """Guard a breakdown key against the declared event-property set — RAISE at SQL-gen time.

    ``declarable_keys`` is the union of declared event-property keys (the SAME set the view
    projects), or ``None`` when no taxonomy was supplied. A missing taxonomy is a DISTINCT config
    error (name the actual fix); an undeclared key names the key + the declarable set. Both fail
    before any SQL is emitted — never an empty-result silent-swallow, never a query-time error.
    """
    if declarable_keys is None:
        raise ValueError(
            "analytics-kit: a warehouse breakdown query requires a taxonomy on QueryClientConfig"
        )
    if breakdown not in declarable_keys:
        declarable = ", ".join(sorted(declarable_keys)) or "(none)"
        raise ValueError(
            f'analytics-kit: breakdown key "{breakdown}" is not a declared event property; '
            f"declarable keys are: {declarable}"
        )


def collect_declarable_keys(events: dict[str, PropDecl]) -> frozenset[str]:
    """The declarable breakdown-key set — the keys of the SAME projection set the view emits.

    Derived from ``_collect_projection_keys`` (shared with the view generator) so "breakdown key ⇒
    a column the view actually projects" holds by construction. The adapter derives this once from
    ``taxonomy.decl['events']`` and threads it to each ``build_*_sql`` call.
    """
    return frozenset(key for key, _prop_type in _collect_projection_keys(events))


# The `date_trunc` bucket unit, mirroring the HTTP adapter's `_INTERVAL_FOR_UNIT`: minute/hour
# collapse to `hour`; day/week/month pass through. A closed enum lookup (never free text), so
# interpolating the result into the SQL is safe — the same discipline `_CAST_TYPE` uses.
#
# This is a DISTINCT axis from `_INTERVAL_KEYWORD_FOR_WINDOW_UNIT` below (bucket GRAIN vs the
# `generate_series` STEP keyword) that currently coincides value-for-value. They are kept as two
# tables on purpose — a desync between them (the spine stepping at a different grain than the
# buckets truncate to) would silently misalign the LEFT JOIN. The `_CANONICAL_TREND_SQL_HOURLY`
# pin exercises the sub-day case where both feed the SAME query, so any divergence trips a gate.
_BUCKET_UNIT_FOR_WINDOW_UNIT: dict[str, str] = {
    "minute": "hour",
    "hour": "hour",
    "day": "day",
    "week": "week",
    "month": "month",
}

# The plural interval keyword for the `generate_series` step and the window lower bound.
# Conceptually distinct from `_BUCKET_UNIT_FOR_WINDOW_UNIT` (see its note) though currently the same
# values — the hourly canonical pin guards the two staying in step.
_INTERVAL_KEYWORD_FOR_WINDOW_UNIT: dict[str, str] = {
    "minute": "hour",
    "hour": "hour",
    "day": "day",
    "week": "week",
    "month": "month",
}

# The `to_char` format per bucket unit. `to_char` is immune to session `DateStyle`/`TimeZone`, so
# the emitted bucket string is deterministic regardless of the consumer's driver settings. Hour
# buckets carry the time component; day/week/month render a bare ISO date — the exact shape the
# frozen row fixtures pin ('2026-07-01').
_BUCKET_FORMAT_FOR_UNIT: dict[str, str] = {
    "hour": 'YYYY-MM-DD"T"HH24:00:00',
    "day": "YYYY-MM-DD",
    "week": "YYYY-MM-DD",
    "month": "YYYY-MM-DD",
}


def _count_expr(aggregation: Aggregation) -> str:
    """``count(*)`` for ``total``; ``count(distinct distinct_id)`` for ``unique``/``dau``.

    unique_count is always distinct actors, so it maps to the same distinct count.
    """
    return "count(*)" if aggregation == "total" else "count(distinct distinct_id)"


@dataclass(frozen=True)
class WarehouseQuery:
    """The generated SQL + positional params for a warehouse query.

    ``params`` carries the ONE consumer value (the event name); everything else is inlined
    structural SQL, so the generated string is byte-identical across both language trees.
    """

    sql: str
    params: list[object]


def _trend_walk_sql(
    *,
    count_expr: str,
    window: Duration,
    breakdown: str | None,
    declarable_keys: frozenset[str] | None,
) -> str:
    """Emit the shared trend walk as Postgres SQL over the typed view.

    A ``generate_series`` spine over the window at the bucket interval is LEFT JOINed to the grouped
    counts so an empty bucket yields ``value: 0``, never a gap. With a breakdown, the spine is CROSS
    JOINed against the OBSERVED breakdown values (each series present in the window is dense over the
    spine; a value the window never produced is not a series and nothing is filled for it). The event
    name is the ONE value bound as a positional param (``$1``); the interval/unit/format are
    structural and inlined.
    """
    bucket_unit = _BUCKET_UNIT_FOR_WINDOW_UNIT[window.unit]
    interval_keyword = _INTERVAL_KEYWORD_FOR_WINDOW_UNIT[window.unit]
    bucket_format = _BUCKET_FORMAT_FOR_UNIT[bucket_unit]
    step_interval = f"interval '1 {interval_keyword}'"
    window_interval = f"interval '{window.value} {interval_keyword}'"

    lower_bound = f"date_trunc('{bucket_unit}', now() - {window_interval})"
    upper_bound = f"date_trunc('{bucket_unit}', now())"
    spine = f"generate_series({lower_bound}, {upper_bound}, {step_interval})"
    bucket_label = f"to_char(spine.bucket, '{bucket_format}')"

    if breakdown is None:
        return "\n".join(
            [
                "WITH counts AS (",
                f"  SELECT date_trunc('{bucket_unit}', timestamp) AS bucket, {count_expr} AS value",
                f"  FROM {EVENTS_VIEW}",
                f"  WHERE event = $1 AND timestamp >= {lower_bound}",
                f"  GROUP BY date_trunc('{bucket_unit}', timestamp)",
                ")",
                f"SELECT {bucket_label} AS bucket, coalesce(counts.value, 0) AS value",
                f"FROM {spine} AS spine(bucket)",
                "  LEFT JOIN counts ON counts.bucket = spine.bucket",
                "ORDER BY spine.bucket",
            ]
        )

    _require_declared(breakdown, declarable_keys)
    breakdown_col = _breakdown_column(breakdown)
    return "\n".join(
        [
            "WITH counts AS (",
            f"  SELECT date_trunc('{bucket_unit}', timestamp) AS bucket, {breakdown_col} AS breakdown, {count_expr} AS value",
            f"  FROM {EVENTS_VIEW}",
            f"  WHERE event = $1 AND timestamp >= {lower_bound}",
            f"  GROUP BY date_trunc('{bucket_unit}', timestamp), {breakdown_col}",
            "),",
            "series AS (SELECT DISTINCT breakdown FROM counts)",
            f"SELECT {bucket_label} AS bucket, coalesce(counts.value, 0) AS value, series.breakdown AS breakdown",
            f"FROM {spine} AS spine(bucket)",
            "  CROSS JOIN series",
            "  LEFT JOIN counts ON counts.bucket = spine.bucket AND counts.breakdown IS NOT DISTINCT FROM series.breakdown",
            "ORDER BY series.breakdown, spine.bucket",
        ]
    )


def build_trend_sql(
    spec: TrendSpec, declarable_keys: frozenset[str] | None = None
) -> WarehouseQuery:
    """The generated SQL + params for a ``trend`` query.

    ``declarable_keys`` is the declared event-property key set (the same set the view projects); a
    ``breakdown`` naming a key outside it — or a breakdown with no taxonomy (``None``) — raises at
    SQL-gen time before any SQL is emitted (see :func:`_require_declared`).
    """
    return WarehouseQuery(
        sql=_trend_walk_sql(
            count_expr=_count_expr(spec.aggregation),
            window=spec.window,
            breakdown=spec.breakdown,
            declarable_keys=declarable_keys,
        ),
        params=[spec.event],
    )


def build_unique_count_sql(
    spec: UniqueCountSpec, declarable_keys: frozenset[str] | None = None
) -> WarehouseQuery:
    """The generated SQL + params for a ``unique_count`` query — always distinct actors."""
    return WarehouseQuery(
        sql=_trend_walk_sql(
            count_expr=_count_expr("unique"),
            window=spec.window,
            breakdown=spec.breakdown,
            declarable_keys=declarable_keys,
        ),
        params=[spec.event],
    )


def _window_interval_literal(within: Duration) -> str:
    """The funnel window as a canonical Postgres interval literal — the ONE serialization both
    trees emit byte-identically. Reuses ``_INTERVAL_KEYWORD_FOR_WINDOW_UNIT`` (minute/hour collapse
    to ``hour``), so ``Duration(7, "day")`` → ``interval '7 day'``.
    """
    keyword = _INTERVAL_KEYWORD_FOR_WINDOW_UNIT[within.unit]
    return f"interval '{within.value} {keyword}'"


def _funnel_walk_sql(
    step_count: int,
    within: Duration,
    breakdown: str | None,
    declarable_keys: frozenset[str] | None,
) -> str:
    """The per-actor ordered-step window walk as a SINGLE Postgres statement, structurally CONSTANT
    regardless of ``step_count`` (only the VALUES rows + the recursion bound vary).

    A recursive step-chase: ``anchor`` fixes each actor's ``t0 = min(timestamp)`` of the step-0
    event; the recursive term advances one step at a time, taking the EARLIEST next-step event that
    is STRICTLY after the prior step's ``reached_at`` (strict ordering) and within the CLOSED window
    ``[t0, t0 + within]`` (INCLUSIVE upper bound, ``<=``). The aggregate lives in a scalar subquery,
    not the recursive term's SELECT list — Postgres forbids the latter (architect-verified against
    Postgres 18.4). The final SELECT LEFT JOINs the observed reaches back onto the step list so a
    step no actor reached still emits a zero row; counts are ``count(distinct distinct_id)``.

    ``run_max``-style window forms are deliberately NOT used: a running ``max(step_index)`` cannot
    honor the STRICT step-to-step inequality (equal-timestamp rows leak across), so it miscounts
    ties. The variadic N-way self-join is the other rejected alternative (join count grows with step
    count). The emitted string is byte-identical to the TypeScript ``warehouse-sql.ts`` for the same
    spec.
    """
    window_interval = _window_interval_literal(within)
    values_rows = ", ".join(f"({i}, ${i + 1})" for i in range(step_count))
    within_step = (
        f"m.timestamp > w.reached_at AND m.timestamp <= w.t0 + {window_interval}"
    )

    if breakdown is None:
        return "\n".join(
            [
                "WITH RECURSIVE steps(step_index, event_name) AS (",
                f"  VALUES {values_rows}",
                "),",
                "matched AS (",
                "  SELECT e.distinct_id, s.step_index, e.timestamp",
                f"  FROM {EVENTS_VIEW} e",
                "  JOIN steps s ON e.event = s.event_name",
                "),",
                "anchor AS (",
                "  SELECT distinct_id, min(timestamp) AS t0",
                "  FROM matched WHERE step_index = 0",
                "  GROUP BY distinct_id",
                "),",
                "walk AS (",
                "  SELECT a.distinct_id, 0 AS step_index, a.t0 AS reached_at, a.t0",
                "  FROM anchor a",
                "  UNION ALL",
                "  SELECT w.distinct_id, w.step_index + 1,",
                "    (SELECT min(m.timestamp) FROM matched m",
                f"      WHERE m.distinct_id = w.distinct_id AND m.step_index = w.step_index + 1 AND {within_step}),",
                "    w.t0",
                "  FROM walk w",
                f"  WHERE w.step_index + 1 < {step_count}",
                "    AND EXISTS (SELECT 1 FROM matched m",
                f"      WHERE m.distinct_id = w.distinct_id AND m.step_index = w.step_index + 1 AND {within_step})",
                ")",
                "SELECT s.step_index, s.event_name, count(DISTINCT w.distinct_id) AS actor_count",
                "FROM steps s",
                "  LEFT JOIN walk w ON w.step_index = s.step_index AND w.reached_at IS NOT NULL",
                "GROUP BY s.step_index, s.event_name",
                "ORDER BY s.step_index",
            ]
        )

    _require_declared(breakdown, declarable_keys)
    breakdown_col = _breakdown_column(breakdown)
    return "\n".join(
        [
            "WITH RECURSIVE steps(step_index, event_name) AS (",
            f"  VALUES {values_rows}",
            "),",
            "matched AS (",
            f"  SELECT e.distinct_id, s.step_index, e.timestamp, {breakdown_col} AS bd",
            f"  FROM {EVENTS_VIEW} e",
            "  JOIN steps s ON e.event = s.event_name",
            "),",
            "anchor AS (",
            "  SELECT distinct_id, min(timestamp) AS t0, (array_agg(bd ORDER BY timestamp))[1] AS bd",
            "  FROM matched WHERE step_index = 0",
            "  GROUP BY distinct_id",
            "),",
            "walk AS (",
            "  SELECT a.distinct_id, 0 AS step_index, a.t0 AS reached_at, a.t0, a.bd",
            "  FROM anchor a",
            "  UNION ALL",
            "  SELECT w.distinct_id, w.step_index + 1,",
            "    (SELECT min(m.timestamp) FROM matched m",
            f"      WHERE m.distinct_id = w.distinct_id AND m.step_index = w.step_index + 1 AND {within_step}),",
            "    w.t0, w.bd",
            "  FROM walk w",
            f"  WHERE w.step_index + 1 < {step_count}",
            "    AND EXISTS (SELECT 1 FROM matched m",
            f"      WHERE m.distinct_id = w.distinct_id AND m.step_index = w.step_index + 1 AND {within_step})",
            ")",
            "SELECT s.step_index, s.event_name, w.bd AS breakdown, count(DISTINCT w.distinct_id) AS actor_count",
            "FROM steps s",
            "  LEFT JOIN walk w ON w.step_index = s.step_index AND w.reached_at IS NOT NULL",
            "GROUP BY s.step_index, s.event_name, w.bd",
            "ORDER BY w.bd, s.step_index",
        ]
    )


def build_funnel_sql(
    spec: FunnelSpec, declarable_keys: frozenset[str] | None = None
) -> WarehouseQuery:
    """The generated funnel SQL + params.

    Each step's event name is bound as a positional param (``$1``..``$N`` in step order); ``within``
    is inlined as a canonical interval literal; the breakdown key (when present) groups on the typed
    view column ``("<key>")::text``, exactly as the trend breakdown does — and must be a declared
    event property (``declarable_keys``) or SQL-gen raises.
    """
    return WarehouseQuery(
        sql=_funnel_walk_sql(len(spec.steps), spec.within, spec.breakdown, declarable_keys),
        params=list(spec.steps),
    )


def _retention_walk_sql(
    periods: int,
    granularity: Granularity,
    breakdown: str | None,
    declarable_keys: frozenset[str] | None,
) -> str:
    """The cohort self-join as a SINGLE Postgres statement producing a DENSE ``cohorts × periods``
    grid.

    A cohort is the set of actors who did the cohort event (``$1``) in a
    ``date_trunc(granularity, timestamp)`` bucket, keyed by that bucket start (the neutral
    ``cohort`` label). For each cohort bucket and each period offset ``0 .. periods-1``, the cell is
    ``count(distinct distinct_id)`` of cohort members who did the RETURN event (``$2``) in
    ``cohort_bucket + offset * interval``.

    ``period_index = 0`` is the cohort's OWN period (the LOCKED convention): the offset-0 cell counts
    members who returned in the cohort's own bucket (``offset * interval = 0``), NOT the first
    subsequent bucket. This is the base cohort size measured via the return event — matching the
    ``retention_cohorts`` fixture (index 0 = the cohort itself).

    DENSE, bounded, deterministic: ``generate_series(0, periods-1)`` is CROSS JOINed against the
    distinct cohort buckets to build the full grid, and the distinct-actor counts are LEFT JOINed
    onto it, so every ``(cohort, period_index)`` cell emits a row — ``coalesce(..., 0)`` fills an
    empty cell with ``0`` rather than dropping it (no gaps). A return event past ``periods-1``
    buckets lands on no grid cell and contributes to nothing (bounded window). The distinct-count is
    grouped per ``(cohort_bucket, period_index[, breakdown])``, so an actor in two cohort buckets
    counts once in EACH cohort's cells — per-cohort, never global.

    With a breakdown, the cohort's breakdown value is anchored at the cohort event (the typed view
    column ``("<key>")::text``, exactly as trend/funnel), one grid per breakdown value; it is carried
    through the grid and the join and stringified onto every row. The emitted string is byte-identical
    to the TypeScript ``warehouse-sql.ts`` for the same spec.
    """
    bucket_format = _BUCKET_FORMAT_FOR_UNIT[granularity]
    offset_interval = f"(g.period_index * interval '1 {granularity}')"
    last_period = periods - 1
    bucket_expr = f"date_trunc('{granularity}', timestamp)"

    if breakdown is None:
        return "\n".join(
            [
                "WITH cohort AS (",
                f"  SELECT distinct_id, {bucket_expr} AS cohort_bucket",
                f"  FROM {EVENTS_VIEW}",
                "  WHERE event = $1",
                f"  GROUP BY distinct_id, {bucket_expr}",
                "),",
                "returns AS (",
                f"  SELECT distinct_id, {bucket_expr} AS return_bucket",
                f"  FROM {EVENTS_VIEW}",
                "  WHERE event = $2",
                f"  GROUP BY distinct_id, {bucket_expr}",
                "),",
                "buckets AS (SELECT DISTINCT cohort_bucket FROM cohort),",
                "grid AS (",
                "  SELECT b.cohort_bucket, p.period_index",
                "  FROM buckets b",
                f"  CROSS JOIN generate_series(0, {last_period}) AS p(period_index)",
                "),",
                "cells AS (",
                "  SELECT g.cohort_bucket, g.period_index, count(DISTINCT c.distinct_id) AS value",
                "  FROM grid g",
                "  JOIN cohort c ON c.cohort_bucket = g.cohort_bucket",
                f"  JOIN returns r ON r.distinct_id = c.distinct_id AND r.return_bucket = g.cohort_bucket + {offset_interval}",
                "  GROUP BY g.cohort_bucket, g.period_index",
                ")",
                f"SELECT to_char(g.cohort_bucket, '{bucket_format}') AS cohort, g.period_index AS period_index, coalesce(cells.value, 0) AS value",
                "FROM grid g",
                "  LEFT JOIN cells ON cells.cohort_bucket = g.cohort_bucket AND cells.period_index = g.period_index",
                "ORDER BY g.cohort_bucket, g.period_index",
            ]
        )

    _require_declared(breakdown, declarable_keys)
    breakdown_col = _breakdown_column(breakdown)
    return "\n".join(
        [
            "WITH cohort AS (",
            f"  SELECT distinct_id, {bucket_expr} AS cohort_bucket, {breakdown_col} AS bd",
            f"  FROM {EVENTS_VIEW}",
            "  WHERE event = $1",
            f"  GROUP BY distinct_id, {bucket_expr}, {breakdown_col}",
            "),",
            "returns AS (",
            f"  SELECT distinct_id, {bucket_expr} AS return_bucket",
            f"  FROM {EVENTS_VIEW}",
            "  WHERE event = $2",
            f"  GROUP BY distinct_id, {bucket_expr}",
            "),",
            "buckets AS (SELECT DISTINCT cohort_bucket, bd FROM cohort),",
            "grid AS (",
            "  SELECT b.cohort_bucket, b.bd, p.period_index",
            "  FROM buckets b",
            f"  CROSS JOIN generate_series(0, {last_period}) AS p(period_index)",
            "),",
            "cells AS (",
            "  SELECT g.cohort_bucket, g.bd, g.period_index, count(DISTINCT c.distinct_id) AS value",
            "  FROM grid g",
            "  JOIN cohort c ON c.cohort_bucket = g.cohort_bucket AND c.bd IS NOT DISTINCT FROM g.bd",
            f"  JOIN returns r ON r.distinct_id = c.distinct_id AND r.return_bucket = g.cohort_bucket + {offset_interval}",
            "  GROUP BY g.cohort_bucket, g.bd, g.period_index",
            ")",
            f"SELECT to_char(g.cohort_bucket, '{bucket_format}') AS cohort, g.period_index AS period_index, coalesce(cells.value, 0) AS value, g.bd AS breakdown",
            "FROM grid g",
            "  LEFT JOIN cells ON cells.cohort_bucket = g.cohort_bucket AND cells.period_index = g.period_index AND cells.bd IS NOT DISTINCT FROM g.bd",
            "ORDER BY g.bd, g.cohort_bucket, g.period_index",
        ]
    )


def build_retention_sql(
    spec: RetentionSpec, declarable_keys: frozenset[str] | None = None
) -> WarehouseQuery:
    """The generated retention SQL + params.

    The cohort event and return event are the two positional params (``$1`` = ``cohort_event``,
    ``$2`` = ``return_event``, in that order); ``periods`` and ``granularity`` are structural (the
    series bound + the truncation/offset unit) and inlined; the breakdown key (when present) groups
    on the typed view column ``("<key>")::text``, exactly as trend/funnel — and must be a declared
    event property (``declarable_keys``) or SQL-gen raises.
    """
    return WarehouseQuery(
        sql=_retention_walk_sql(spec.periods, spec.granularity, spec.breakdown, declarable_keys),
        params=[spec.cohort_event, spec.return_event],
    )


def _column_index(columns: list[DbColumn], name: str) -> int:
    for i, column in enumerate(columns):
        if column.name == name:
            return i
    return -1


def build_trend_rows(result: DbExecuteResult) -> list[TrendRow]:
    """Flatten the positional cells of a :class:`DbExecuteResult` into neutral :class:`TrendRow`\\ s.

    The warehouse analog of the HTTP adapter's ``_build_trend_rows``, but over FLAT tabular cells
    (not engine-nested ``days``/``data``). Reads cells by column name (via the driver-reported
    schema) so a benign column-order change never mis-maps. The bucket string is emitted by the SQL
    (``to_char``) and only guarded here; ``breakdown`` is stringified when the column is present.
    """
    columns = list(result.columns)
    bucket_idx = _column_index(columns, "bucket")
    value_idx = _column_index(columns, "value")
    breakdown_idx = _column_index(columns, "breakdown")

    rows: list[TrendRow] = []
    for cells in result.rows:
        cells_list = list(cells)
        bucket = cells_list[bucket_idx] if 0 <= bucket_idx < len(cells_list) else None
        value = cells_list[value_idx] if 0 <= value_idx < len(cells_list) else None
        if not isinstance(bucket, str) or not isinstance(value, (int, float)) or isinstance(value, bool):
            continue
        breakdown_cell = (
            cells_list[breakdown_idx] if 0 <= breakdown_idx < len(cells_list) else None
        )
        breakdown = None if breakdown_cell is None else str(breakdown_cell)
        rows.append(TrendRow(bucket=bucket, value=value, breakdown=breakdown))
    return rows


def build_funnel_rows(
    steps: list[str],
) -> Callable[[DbExecuteResult], list[FunnelStepRow]]:
    """The funnel flat-row builder.

    The SQL yields one row per step (per breakdown group when broken down):
    ``(step_index, event_name, actor_count[, breakdown])``. This flattens those positional count
    rows into neutral :class:`FunnelStepRow`\\ s — sourcing ``event`` from ``steps[step]`` (the spec
    knows the neutral name; NOT the HTTP adapter's ``custom_name → name → action_id`` wire walk) and
    COMPUTING ``conversion_rate = count[step] / count[0]`` per breakdown group, GUARDED so a zero
    step-0 count yields ``0`` on every step (no NaN/inf leak). Identical guard rule to the HTTP
    ``_build_funnel_rows`` / the ``funnel_zero_first_step`` fixture, so warehouse rows are
    byte-identical.

    Curried on ``steps`` because both the ``event`` label and the per-group step-0 base come from
    data the flat count rows do not carry. Reads cells by column name so a benign column reorder or
    the absence of the ``breakdown`` column never mis-maps.
    """

    def build(result: DbExecuteResult) -> list[FunnelStepRow]:
        columns = list(result.columns)
        step_idx = _column_index(columns, "step_index")
        count_idx = _column_index(columns, "actor_count")
        breakdown_idx = _column_index(columns, "breakdown")

        count_by_group_step: dict[str | None, dict[int, int]] = {}
        group_order: list[str | None] = []
        for cells in result.rows:
            cells_list = list(cells)
            step = cells_list[step_idx] if 0 <= step_idx < len(cells_list) else None
            count = cells_list[count_idx] if 0 <= count_idx < len(cells_list) else None
            if (
                not isinstance(step, int)
                or isinstance(step, bool)
                or not isinstance(count, int)
                or isinstance(count, bool)
            ):
                continue
            breakdown_cell = (
                cells_list[breakdown_idx]
                if 0 <= breakdown_idx < len(cells_list)
                else None
            )
            group = None if breakdown_cell is None else str(breakdown_cell)
            step_counts = count_by_group_step.get(group)
            if step_counts is None:
                step_counts = {}
                count_by_group_step[group] = step_counts
                group_order.append(group)
            step_counts[step] = count

        rows: list[FunnelStepRow] = []
        for group in group_order:
            step_counts = count_by_group_step[group]
            first_count = step_counts.get(0, 0)
            for step in sorted(step_counts):
                if step >= len(steps):
                    continue
                count = step_counts[step]
                conversion_rate = 0.0 if first_count == 0 else count / first_count
                rows.append(
                    FunnelStepRow(
                        step=step,
                        event=steps[step],
                        count=count,
                        conversion_rate=conversion_rate,
                        breakdown=group,
                    )
                )
        return rows

    return build


def build_retention_rows(result: DbExecuteResult) -> list[RetentionRow]:
    """Flatten the positional cells of a :class:`DbExecuteResult` into neutral
    :class:`RetentionRow`\\ s.

    The SQL yields one row per DENSE ``(cohort, period_index)`` cell (per breakdown value when broken
    down): ``(cohort, period_index, value[, breakdown])``. This flattens those positional cells into
    one :class:`RetentionRow` per cell — ``value=0`` for an empty cell (the grid is dense, so a zero
    cell is a present row, never a gap). Sources ``cohort`` + ``period_index`` + ``value`` straight
    from the flat cells (NOT the HTTP adapter's nested ``date`` + indexed ``values[]`` walk — the
    RULE ``period_index=0 = the cohort's own period`` is shared, the SHAPE is not). Reads cells by
    column name so a benign column reorder or the absence of the ``breakdown`` column never mis-maps.
    """
    columns = list(result.columns)
    cohort_idx = _column_index(columns, "cohort")
    period_idx = _column_index(columns, "period_index")
    value_idx = _column_index(columns, "value")
    breakdown_idx = _column_index(columns, "breakdown")

    rows: list[RetentionRow] = []
    for cells in result.rows:
        cells_list = list(cells)
        cohort = cells_list[cohort_idx] if 0 <= cohort_idx < len(cells_list) else None
        period_index = (
            cells_list[period_idx] if 0 <= period_idx < len(cells_list) else None
        )
        value = cells_list[value_idx] if 0 <= value_idx < len(cells_list) else None
        if (
            not isinstance(cohort, str)
            or not isinstance(period_index, int)
            or isinstance(period_index, bool)
            or not isinstance(value, (int, float))
            or isinstance(value, bool)
        ):
            continue
        breakdown_cell = (
            cells_list[breakdown_idx] if 0 <= breakdown_idx < len(cells_list) else None
        )
        breakdown = None if breakdown_cell is None else str(breakdown_cell)
        rows.append(
            RetentionRow(
                cohort=cohort,
                period_index=period_index,
                value=value,
                breakdown=breakdown,
            )
        )
    return rows


def _zip_row(row: object, columns: list[DbColumn]) -> dict[str, object]:
    """The columns-present zip — a warehouse-local twin of the HTTP adapter's private ``_zip_row``
    (``http_adapter.py:356``), kept co-located with the warehouse builders rather than importing a
    private cross-module helper.

    SAME positional-cell zip behavior: a list row is keyed by column order; a row that is already a
    dict passes through; anything else yields ``{}``. The HTTP ``_zip_row`` takes neutral
    :class:`~analytics_kit.QueryColumn`\\ s; this twin takes :class:`DbColumn`\\ s directly (reading
    only ``column.name``), so no cross-type conversion is needed at the call site.
    """
    if isinstance(row, list):
        return {column.name: row[i] if i < len(row) else None for i, column in enumerate(columns)}
    if isinstance(row, dict):
        return row
    return {}


def build_raw_rows(result: DbExecuteResult) -> list[Mapping[str, object]]:
    """``raw_query``'s flat-row builder — the ONE primitive that is NOT per-primitive-shaped.

    The consumer's own SELECT projection is already neutral, so each positional cell row is zipped
    into a column-keyed object via the driver-reported columns. The warehouse analog of the HTTP
    adapter's columns-present raw branch; :class:`DbExecuteResult` ALWAYS carries ``columns`` (unlike
    the optional HTTP wire ``columns``), so this is unconditionally the zip path. Returns
    ``Mapping[str, object]`` rows — the ``QueryResult`` default row type ``raw_query`` carries.
    """
    columns = list(result.columns)
    return [_zip_row(list(row), columns) for row in result.rows]


WarehouseRowBuilder = Callable[[DbExecuteResult], "list[_TRow]"]
"""A flat-row builder: a :class:`DbExecuteResult` in, the primitive's neutral rows out.

Sibling of the HTTP adapter's ``RowBuilder``, but its source is the positional
:class:`DbExecuteResult` rather than a wire envelope. S2–S4 each supply their own.
"""


def assemble_result(
    result: DbExecuteResult, row_builder: WarehouseRowBuilder[_TRow]
) -> QueryResult[_TRow]:
    """The shared assembler — the warehouse analog of the HTTP adapter's ``_normalize_result``.

    Takes a :class:`DbExecuteResult` + a flat-row builder and produces a neutral
    :class:`~analytics_kit.QueryResult`: it stamps ``columns`` from the driver-reported SELECT schema
    (:class:`DbColumn` → :class:`~analytics_kit.QueryColumn`, carrying ``type`` only when present)
    and ``generated_at``, and OMITS ``from_cache`` (a live SQL exec has no cache envelope — the
    optional field is left off, never fabricated). Unlike the HTTP structured path (which forces
    ``columns=[]``), the warehouse STAMPS ``columns``: they are the neutral SELECT schema, not engine
    wire tokens. S2–S4 reuse this verbatim, threading only their own flat-row builder.
    """
    columns = [QueryColumn(name=column.name, type=column.type) for column in result.columns]
    return QueryResult[_TRow](
        rows=row_builder(result),
        columns=columns,
        generated_at=datetime.now(timezone.utc).isoformat(),
    )
