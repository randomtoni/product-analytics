"""The warehouse SQL-generation module — pure builders + the shared result assembler.

Emits Postgres SQL as **strings only** over the E17 taxonomy-generated typed VIEW
(:data:`~analytics_kit.query.warehouse_schema.EVENTS_VIEW`), plus the shared assembler that
normalizes a driver's :class:`~analytics_kit.query.db_execute.DbExecuteResult` into the neutral
:class:`~analytics_kit.QueryResult`. Imports no database driver and executes nothing — a caller
routes the emitted SQL through the injected :class:`~analytics_kit.query.db_execute.DbExecute` seam.
The trend/unique_count builder is the first resident; funnel/retention/raw builders (S2–S4) join it.

Never targets the base ``events`` table and never reads ``properties`` directly EXCEPT the breakdown
path (``properties ->> '<key>'``) — breakdown is a runtime string, not a typed view column, so it
reads the JSONB path; the bucketed/counted columns come from the view.

Parity is by shared contract, not shared code: the emitted SQL is Postgres (language-agnostic) and
**byte-identical** to the TypeScript ``warehouse-sql.ts`` for the same spec; only the surrounding
builder code is cased idiomatically.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from typing import Callable, TypeVar

from .client import (
    Aggregation,
    Duration,
    QueryColumn,
    QueryResult,
    TrendRow,
    TrendSpec,
    UniqueCountSpec,
)
from .db_execute import DbColumn, DbExecuteResult
from .warehouse_schema import EVENTS_VIEW

__all__ = [
    "WarehouseQuery",
    "WarehouseRowBuilder",
    "build_trend_sql",
    "build_unique_count_sql",
    "build_trend_rows",
    "assemble_result",
]

_TRow = TypeVar("_TRow")


def _quote_literal(value: str) -> str:
    """Single-quote a SQL string literal — the same escaping the view generator applies to consumer
    keys, kept consistent so the breakdown JSONB key path and the view share one story."""
    escaped = value.replace("'", "''")
    return f"'{escaped}'"


# The `date_trunc` bucket unit, mirroring the HTTP adapter's `_INTERVAL_FOR_UNIT`: minute/hour
# collapse to `hour`; day/week/month pass through. A closed enum lookup (never free text), so
# interpolating the result into the SQL is safe — the same discipline `_CAST_TYPE` uses.
_BUCKET_UNIT_FOR_WINDOW_UNIT: dict[str, str] = {
    "minute": "hour",
    "hour": "hour",
    "day": "day",
    "week": "week",
    "month": "month",
}

# The plural interval keyword for the `generate_series` step and the window lower bound.
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
    *, count_expr: str, window: Duration, breakdown: str | None
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

    breakdown_path = f"properties ->> {_quote_literal(breakdown)}"
    return "\n".join(
        [
            "WITH counts AS (",
            f"  SELECT date_trunc('{bucket_unit}', timestamp) AS bucket, {breakdown_path} AS breakdown, {count_expr} AS value",
            f"  FROM {EVENTS_VIEW}",
            f"  WHERE event = $1 AND timestamp >= {lower_bound}",
            f"  GROUP BY date_trunc('{bucket_unit}', timestamp), {breakdown_path}",
            "),",
            "series AS (SELECT DISTINCT breakdown FROM counts)",
            f"SELECT {bucket_label} AS bucket, coalesce(counts.value, 0) AS value, series.breakdown AS breakdown",
            f"FROM {spine} AS spine(bucket)",
            "  CROSS JOIN series",
            "  LEFT JOIN counts ON counts.bucket = spine.bucket AND counts.breakdown IS NOT DISTINCT FROM series.breakdown",
            "ORDER BY series.breakdown, spine.bucket",
        ]
    )


def build_trend_sql(spec: TrendSpec) -> WarehouseQuery:
    """The generated SQL + params for a ``trend`` query."""
    return WarehouseQuery(
        sql=_trend_walk_sql(
            count_expr=_count_expr(spec.aggregation),
            window=spec.window,
            breakdown=spec.breakdown,
        ),
        params=[spec.event],
    )


def build_unique_count_sql(spec: UniqueCountSpec) -> WarehouseQuery:
    """The generated SQL + params for a ``unique_count`` query — always distinct actors."""
    return WarehouseQuery(
        sql=_trend_walk_sql(
            count_expr=_count_expr("unique"),
            window=spec.window,
            breakdown=spec.breakdown,
        ),
        params=[spec.event],
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
