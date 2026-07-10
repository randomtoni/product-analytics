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

__version__ = "0.0.0"

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
    "create_analytics",
]
