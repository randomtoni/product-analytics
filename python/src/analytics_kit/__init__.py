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
from .config import AnalyticsConfig
from .factory import create_analytics
from .neutral_event import (
    InternalKind,
    NeutralEvent,
    NeutralProperties,
    NeutralTraits,
)
from .noop import NoopAdapter
from .ports import FeatureFlagPort, SessionReplayPort
from .provider import Analytics
from .server import (
    BatchConsumer,
    ServerAdapter,
    Transport,
    UrllibTransport,
    create_server_analytics,
)
from .taxonomy import (
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
    "Analytics",
    "AnalyticsConfig",
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
    "SingleEventCapture",
]
