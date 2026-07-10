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
    QueryResult,
    RetentionSpec,
    TrendSpec,
    UniqueCountSpec,
)

_NOT_IMPLEMENTED = "analytics-kit: warehouse query adapter is not yet implemented"


class WarehouseQueryAdapter:
    """A typed, not-yet-implemented warehouse backend satisfying ``AnalyticsQueryClient``.

    The bar-A proof: it conforms to the same neutral read seam as the HTTP adapter by shape, with
    zero Protocol change. Each primitive raises :class:`NotImplementedError` — the shape is proven,
    the body is the fill-in seat (see the module docstring's per-method SQL mapping).
    """

    def funnel(self, spec: FunnelSpec) -> QueryResult:
        raise NotImplementedError(_NOT_IMPLEMENTED)

    def retention(self, spec: RetentionSpec) -> QueryResult:
        raise NotImplementedError(_NOT_IMPLEMENTED)

    def trend(self, spec: TrendSpec) -> QueryResult:
        raise NotImplementedError(_NOT_IMPLEMENTED)

    def unique_count(self, spec: UniqueCountSpec) -> QueryResult:
        raise NotImplementedError(_NOT_IMPLEMENTED)

    def raw_query(self, expr: str) -> QueryResult:
        raise NotImplementedError(_NOT_IMPLEMENTED)


def create_warehouse_query_adapter() -> AnalyticsQueryClient:
    """Construct the warehouse query adapter as an :class:`AnalyticsQueryClient`.

    Exported and constructable, but NOT the default — ``create_query_client`` selects the no-op or
    the HTTP adapter; config-driven HTTP↔warehouse selection is a future additive step.
    """
    return WarehouseQueryAdapter()
