"""The warehouse query adapter — a second query backend, named by ROLE (never a vendor).

A TYPED STUB: every member satisfies :class:`~analytics_kit.AnalyticsQueryClient` and typechecks,
but no method computes — each raises a neutral not-implemented error. Its reason to exist is the
bar-A proof: a second adapter satisfies the SAME neutral interface as the HTTP adapter, with zero
change to the Protocol. Swapping the HTTP backend for a SQL-over-warehouse backend is one adapter,
zero consumer change.

Every member is a plain ``def`` (NOT ``async def``) returning :class:`~analytics_kit.QueryResult`,
matching the sync Protocol posture — an ``async def`` would return a coroutine, not a
``QueryResult``, and fail the structural-conformance check, so the sync signature is load-bearing.

Intended per-method SQL mapping (the fill-in seat — enough to be fill-in-the-blanks, not a
redesign). The first real fill-in emits SQL over the taxonomy-generated typed VIEW (safe-cast
projections over the event base), targeting the view's columns generically — NO consumer
event/domain name is baked into any SQL here:

- ``funnel(spec)`` — SELECT ordered step-completion counts from the typed view, restricting to
  ``spec.steps`` in order, keeping only actors whose step timestamps fall inside ``spec.within``;
  GROUP BY ``spec.breakdown`` when present.
- ``retention(spec)`` — self-join the typed view: cohort rows (``spec.cohort_event``) against
  return rows (``spec.return_event``) bucketed by ``spec.granularity`` for ``spec.periods``
  periods; GROUP BY ``spec.breakdown`` when present.
- ``trend(spec)`` — SELECT a time series over ``spec.window`` at the derived interval, aggregated
  per ``spec.aggregation`` (count of rows for total, count of distinct actors for unique/dau);
  GROUP BY ``spec.breakdown`` when present.
- ``unique_count(spec)`` — SELECT the count of distinct actors over ``spec.window`` for the event.
- ``raw_query(expr)`` — passes ``expr`` to the SQL engine AS SQL (this adapter's dialect is SQL,
  vs the query-dialect string the HTTP adapter speaks — the split that justifies ``raw_query``
  taking a plain string and naming no dialect).

Every real body would normalize the driver's rows/columns into the neutral ``QueryResult`` before
returning, exactly as the HTTP adapter normalizes its wire envelope.
"""

from __future__ import annotations

from .client import (
    AnalyticsQueryClient,
    FunnelSpec,
    FunnelStepRow,
    QueryResult,
    RetentionRow,
    RetentionSpec,
    TrendRow,
    TrendSpec,
    UniqueCountRow,
    UniqueCountSpec,
)
from .config import QueryClientConfig
from .db_execute import DbExecute
from .default_db_execute import create_default_db_execute
from .warehouse_sql import (
    assemble_result,
    build_trend_rows,
    build_trend_sql,
    build_unique_count_sql,
)

_NOT_IMPLEMENTED = "analytics-kit: warehouse query adapter is not yet implemented"


class WarehouseQueryAdapter:
    """A typed, not-yet-implemented warehouse backend satisfying ``AnalyticsQueryClient``.

    The bar-A proof: it conforms to the same neutral read seam as the HTTP adapter by shape, with
    zero Protocol change. Each primitive raises :class:`NotImplementedError` — the shape is proven,
    the body is the fill-in seat (see the module docstring's per-method SQL mapping).

    Holds the injected :class:`~analytics_kit.query.db_execute.DbExecute` seam OPAQUE — exactly as
    the HTTP adapter holds its transport. Required: the adapter's whole reason to exist is to route
    SQL through this seam (E18), so there is no "no exec" state. The adapter NEVER sees a DSN or a
    driver handle and never imports the driver; the DSN→driver build lives at the
    :func:`create_warehouse_query_adapter_from_config` boundary.
    """

    def __init__(self, *, db_execute: DbExecute) -> None:
        self._db_execute = db_execute

    def funnel(self, spec: FunnelSpec) -> QueryResult[FunnelStepRow]:
        raise NotImplementedError(_NOT_IMPLEMENTED)

    def retention(self, spec: RetentionSpec) -> QueryResult[RetentionRow]:
        raise NotImplementedError(_NOT_IMPLEMENTED)

    def trend(self, spec: TrendSpec) -> QueryResult[TrendRow]:
        query = build_trend_sql(spec)
        result = self._db_execute.execute(query.sql, query.params)
        return assemble_result(result, build_trend_rows)

    def unique_count(self, spec: UniqueCountSpec) -> QueryResult[UniqueCountRow]:
        query = build_unique_count_sql(spec)
        result = self._db_execute.execute(query.sql, query.params)
        # ``unique_count`` shares ``TrendRow``'s field set; the same flat-row builder produces both,
        # then the neutral rows are re-typed to the own-named ``UniqueCountRow`` at the boundary.
        return assemble_result(
            result,
            lambda r: [
                UniqueCountRow(bucket=row.bucket, value=row.value, breakdown=row.breakdown)
                for row in build_trend_rows(r)
            ],
        )

    def raw_query(self, expr: str) -> QueryResult:
        raise NotImplementedError(_NOT_IMPLEMENTED)


def create_warehouse_query_adapter(*, db_execute: DbExecute) -> AnalyticsQueryClient:
    """Construct the warehouse query adapter from an already-built :class:`DbExecute`.

    The low-level DI twin of :func:`~analytics_kit.query.http_adapter.create_http_query_adapter`:
    a caller (or a test with a fake exec) that already holds a ``DbExecute`` injects it directly,
    skipping DSN parsing. Returns an :class:`AnalyticsQueryClient` (satisfied structurally).
    """
    return WarehouseQueryAdapter(db_execute=db_execute)


def create_warehouse_query_adapter_from_config(
    config: QueryClientConfig,
) -> AnalyticsQueryClient:
    """Build the warehouse adapter from a ``warehouse_dsn``-carrying :class:`QueryClientConfig`.

    The config-reading twin of
    :func:`~analytics_kit.query.http_adapter.create_http_query_adapter`: it reads
    ``warehouse_dsn``, builds the default :class:`DbExecute` driver from it, and injects it. The
    driver import stays behind the ``analytics-kit[warehouse]`` extra — importing this module does
    not import the driver; only CONSTRUCTING the default driver here does. Reached only via
    ``create_query_client``'s warehouse rung, where ``warehouse_dsn`` is known present.
    """
    return WarehouseQueryAdapter(
        db_execute=create_default_db_execute(config.warehouse_dsn or "")
    )
