"""The warehouse query adapter — a second query backend, named by ROLE (never a vendor).

Every member satisfies :class:`~analytics_kit.AnalyticsQueryClient` and COMPUTES: it emits SQL over
the taxonomy-generated typed VIEW (safe-cast projections over the event base), routes it through the
injected DB-execute seam, and normalizes the driver's rows/columns into the neutral
:class:`~analytics_kit.QueryResult` — exactly as the HTTP adapter normalizes its wire envelope. This
is the bar-A proof made real: a second adapter satisfies the SAME neutral interface as the HTTP
adapter, with zero change to the Protocol, and returns the same neutral rows. Swapping the HTTP
backend for a SQL-over-warehouse backend is one adapter, zero consumer change.

Every member is a plain ``def`` (NOT ``async def``) returning :class:`~analytics_kit.QueryResult`,
matching the sync Protocol posture — an ``async def`` would return a coroutine, not a
``QueryResult``, and fail the structural-conformance check, so the sync signature is load-bearing.

The per-method SQL is generated in :mod:`analytics_kit.query.warehouse_sql`, targeting the view's
columns generically — NO consumer event/domain name is baked into any SQL here:

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
- ``raw_query(expr)`` — passes ``expr`` to the SQL engine AS SQL; see the ``raw_query`` method for
  the SQL-vs-HogQL dialect split (the ONE primitive that is NOT provider-swap-portable).
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
from ..taxonomy import Taxonomy
from .config import QueryClientConfig
from .db_execute import DbExecute
from .default_db_execute import create_default_db_execute
from .warehouse_sql import (
    assemble_result,
    build_funnel_rows,
    build_funnel_sql,
    build_raw_rows,
    build_retention_rows,
    build_retention_sql,
    build_trend_rows,
    build_trend_sql,
    build_unique_count_sql,
    collect_declarable_keys,
)


class WarehouseQueryAdapter:
    """A warehouse backend satisfying ``AnalyticsQueryClient`` — SQL over the typed view.

    The bar-A proof: it conforms to the same neutral read seam as the HTTP adapter by shape, with
    zero Protocol change, and returns the same neutral rows. Each primitive generates SQL (see the
    module docstring's per-method SQL mapping), routes it through the injected seam, and normalizes
    the driver result into a neutral ``QueryResult``.

    Holds the injected :class:`~analytics_kit.query.db_execute.DbExecute` seam OPAQUE — exactly as
    the HTTP adapter holds its transport. Required: the adapter's whole reason to exist is to route
    SQL through this seam (E18), so there is no "no exec" state. The adapter NEVER sees a DSN or a
    driver handle and never imports the driver; the DSN→driver build lives at the
    :func:`create_warehouse_query_adapter_from_config` boundary.

    Also holds the OPTIONAL ``taxonomy`` — neutral config, not a driver handle, so it honors the
    "adapter holds only DbExecute, never a DSN/driver handle" rule. The declarable-key set (the same
    keys the typed view projects) is derived from it once and threaded to the ``build_*_sql`` builders
    so a breakdown query can enforce "breakdown key is a declared event property" at SQL-gen time.
    With no taxonomy the declarable set is ``None`` — the four non-breakdown primitives + ``raw_query``
    run unchanged; only a breakdown query raises (a distinct missing-taxonomy config error).
    """

    def __init__(self, *, db_execute: DbExecute, taxonomy: Taxonomy | None = None) -> None:
        self._db_execute = db_execute
        self._declarable_keys = (
            None if taxonomy is None else collect_declarable_keys(taxonomy.decl["events"])
        )

    def funnel(self, spec: FunnelSpec) -> QueryResult[FunnelStepRow]:
        query = build_funnel_sql(spec, self._declarable_keys)
        result = self._db_execute.execute(query.sql, query.params)
        # ``event`` + the per-group conversion_rate base come from the spec, not the flat count
        # rows — the builder is curried on ``spec.steps``.
        return assemble_result(result, build_funnel_rows(spec.steps))

    def retention(self, spec: RetentionSpec) -> QueryResult[RetentionRow]:
        query = build_retention_sql(spec, self._declarable_keys)
        result = self._db_execute.execute(query.sql, query.params)
        return assemble_result(result, build_retention_rows)

    def trend(self, spec: TrendSpec) -> QueryResult[TrendRow]:
        query = build_trend_sql(spec, self._declarable_keys)
        result = self._db_execute.execute(query.sql, query.params)
        return assemble_result(result, build_trend_rows)

    def unique_count(self, spec: UniqueCountSpec) -> QueryResult[UniqueCountRow]:
        query = build_unique_count_sql(spec, self._declarable_keys)
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
        # The SQL-vs-HogQL DIALECT SPLIT. ``raw_query`` passes ``expr`` to the engine AS SQL,
        # verbatim — NO ``kind`` discriminator, NO dialect wrapping (that is the HTTP adapter's wire
        # vocabulary). This adapter's dialect is SQL (Postgres, over EVENTS_VIEW / the consumer's own
        # schema); the HTTP adapter's is HogQL. Same neutral signature (``raw_query(expr) ->
        # QueryResult``), but a DIFFERENT dialect the ``expr`` string must speak — so ``raw_query`` is
        # the ONE query primitive that is NOT provider-swap-portable: an ``expr`` written for one
        # backend's dialect will not run verbatim on the other. The four structured primitives
        # (funnel/retention/trend/unique_count) ARE provider-swap-portable — they take neutral specs.
        # ``raw_query`` trades that portability for an escape hatch, BY DESIGN. This is not a bar-A
        # violation: the OUTPUT stays a neutral ``QueryResult`` (the columns-present zip normalizes the
        # driver rows to column-keyed objects); only the INPUT ``expr`` is dialect-keyed. The consumer
        # owns ``expr`` — it is passed unsanitized and unparameterized, consistent with the HTTP
        # adapter's raw_query posture (a deliberate raw escape hatch, not a place for injection
        # hardening).
        result = self._db_execute.execute(expr)
        return assemble_result(result, build_raw_rows)


def create_warehouse_query_adapter(
    *, db_execute: DbExecute, taxonomy: Taxonomy | None = None
) -> AnalyticsQueryClient:
    """Construct the warehouse query adapter from an already-built :class:`DbExecute`.

    The low-level DI twin of :func:`~analytics_kit.query.http_adapter.create_http_query_adapter`:
    a caller (or a test with a fake exec) that already holds a ``DbExecute`` injects it directly,
    skipping DSN parsing. The OPTIONAL ``taxonomy`` supplies the declarable breakdown-key set (a
    breakdown query without it raises); the four non-breakdown primitives never need it. Returns an
    :class:`AnalyticsQueryClient` (satisfied structurally).
    """
    return WarehouseQueryAdapter(db_execute=db_execute, taxonomy=taxonomy)


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

    It also forwards ``config.taxonomy`` (already in hand — this factory receives the whole config)
    to the adapter so a breakdown query can enforce the declared-key set; ``create_query_client`` is
    unchanged.
    """
    return WarehouseQueryAdapter(
        db_execute=create_default_db_execute(config.warehouse_dsn or ""),
        taxonomy=config.taxonomy,
    )
