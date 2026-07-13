"""The query read surface — the neutral ``AnalyticsQueryClient`` seam and its shapes.

Funnel / retention / trend / unique-count primitives plus a ``raw_query`` escape hatch over one
flat :class:`QueryResult`, a separate server-only :class:`QueryClientConfig`, the config-selected
:func:`create_query_client` factory, and the :class:`QueryNoop` null object (bar B). The HTTP
query adapter and the warehouse stub land in later slices of this cycle.
"""

from .client import (
    Aggregation,
    AnalyticsQueryClient,
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
from .factory import create_query_client
from .noop import QueryNoop
from .warehouse_adapter import WarehouseQueryAdapter, create_warehouse_query_adapter

__all__ = [
    "AnalyticsQueryClient",
    "Duration",
    "Granularity",
    "Aggregation",
    "FunnelSpec",
    "RetentionSpec",
    "TrendSpec",
    "UniqueCountSpec",
    "TrendRow",
    "UniqueCountRow",
    "FunnelStepRow",
    "RetentionRow",
    "QueryColumn",
    "QueryResult",
    "QueryTransport",
    "QueryClientConfig",
    "create_query_client",
    "QueryNoop",
    "WarehouseQueryAdapter",
    "create_warehouse_query_adapter",
]
