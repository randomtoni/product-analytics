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
    Granularity,
    QueryColumn,
    QueryResult,
    QueryTransport,
    RetentionSpec,
    TrendSpec,
    UniqueCountSpec,
)
from .config import QueryClientConfig
from .factory import create_query_client
from .noop import QueryNoop

__all__ = [
    "AnalyticsQueryClient",
    "Duration",
    "Granularity",
    "Aggregation",
    "FunnelSpec",
    "RetentionSpec",
    "TrendSpec",
    "UniqueCountSpec",
    "QueryColumn",
    "QueryResult",
    "QueryTransport",
    "QueryClientConfig",
    "create_query_client",
    "QueryNoop",
]
