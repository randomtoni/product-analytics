"""analytics-kit — vendor-neutral analytics abstraction library (Python implementation).

Consuming apps depend on this like a vendored SDK and code against its own neutral interfaces —
never a vendor SDK directly. This is the Python sibling of the TypeScript implementation under
``ts/``; the two stay at capability parity — every capability the TS surface exposes is reachable
here, adapted idiomatically (server-shaped: a plain client + framework bindings, no browser/DOM
concerns).

Scaffold only. The vendor-neutral seam (provider contract, adapter ``Protocol``, typed taxonomy,
allowlist, config-selected factory) is implemented by the Python roadmap cycle.
"""

from .adapter import AnalyticsAdapter, ConsentState, NeutralResponse
from .allowlist import ViolationPolicy, enforce_allowlist
from .config import AnalyticsConfig, FlagBootstrap, FlagsConfig
from .factory import create_analytics
from .flags import (
    FlagClientConfig,
    FlagNoop,
    FlagTransport,
    HttpFlagAdapter,
    create_flag_client,
)
from .neutral_event import (
    InternalKind,
    NeutralEvent,
    NeutralProperties,
    NeutralTraits,
)
from .noop import NoopAdapter
from .ports import (
    FeatureFlagPort,
    FlagContext,
    FlagEvaluateOptions,
    FlagReason,
    FlagSet,
    FlagValue,
    SessionReplayPort,
    empty_flag_set,
)
from .provider import Analytics
from .query import (
    Aggregation,
    AnalyticsQueryClient,
    Duration,
    FunnelSpec,
    FunnelStepRow,
    Granularity,
    QueryClientConfig,
    QueryColumn,
    QueryNoop,
    QueryResult,
    QueryTransport,
    RetentionRow,
    RetentionSpec,
    TrendRow,
    TrendSpec,
    UniqueCountRow,
    UniqueCountSpec,
    WarehouseQueryAdapter,
    create_query_client,
    create_warehouse_query_adapter,
)
from .server import (
    BatchConsumer,
    ServerAdapter,
    Transport,
    UrllibTransport,
    create_server_analytics,
)
from .taxonomy import (
    FlagDecl,
    PropDecl,
    PropType,
    SingleEventCapture,
    Taxonomy,
    TaxonomyDecl,
    define_taxonomy,
    derive_allowlist_from_taxonomy,
)
from .version import __version__

__all__ = [
    "__version__",
    "NeutralEvent",
    "NeutralProperties",
    "NeutralTraits",
    "InternalKind",
    "ConsentState",
    "NeutralResponse",
    "AnalyticsAdapter",
    "FeatureFlagPort",
    "SessionReplayPort",
    "FlagSet",
    "FlagContext",
    "FlagEvaluateOptions",
    "FlagValue",
    "FlagReason",
    "empty_flag_set",
    "FlagClientConfig",
    "FlagTransport",
    "FlagNoop",
    "HttpFlagAdapter",
    "create_flag_client",
    "Analytics",
    "AnalyticsConfig",
    "FlagsConfig",
    "FlagBootstrap",
    "NoopAdapter",
    "ServerAdapter",
    "BatchConsumer",
    "Transport",
    "UrllibTransport",
    "create_analytics",
    "create_server_analytics",
    "enforce_allowlist",
    "ViolationPolicy",
    "define_taxonomy",
    "derive_allowlist_from_taxonomy",
    "Taxonomy",
    "TaxonomyDecl",
    "PropType",
    "PropDecl",
    "FlagDecl",
    "SingleEventCapture",
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
