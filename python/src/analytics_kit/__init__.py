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
from .receiver import (
    Accepted,
    MalformedBody,
    Receiver,
    ReceiverHeaders,
    ReceiveOutcome,
)
from .query import (
    EVENTS_TABLE,
    EVENTS_TABLE_DDL,
    EVENTS_VIEW,
    Aggregation,
    AnalyticsQueryClient,
    DbColumn,
    DbExecute,
    DbExecuteResult,
    DefaultDbExecute,
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
    build_migration_sql,
    build_typed_view_sql,
    create_default_db_execute,
    create_query_client,
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
    "DbColumn",
    "DbExecute",
    "DbExecuteResult",
    "DefaultDbExecute",
    "create_default_db_execute",
    "create_query_client",
    "QueryNoop",
    "EVENTS_TABLE",
    "EVENTS_TABLE_DDL",
    "EVENTS_VIEW",
    "build_typed_view_sql",
    "build_migration_sql",
    "Receiver",
    "ReceiverHeaders",
    "ReceiveOutcome",
    "Accepted",
    "MalformedBody",
]
