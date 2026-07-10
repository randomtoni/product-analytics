"""The config-selected factory — bar B made real.

``create_analytics`` is how a consumer wires the library by configuration alone: parse the
config, resolve the adapter, and construct the provider around it. A supplied adapter is
used as-is; with none supplied the whole stack falls back to the silent :class:`NoopAdapter`
(unkeyed ⇒ silent). Resolution is a supplied-vs-``None`` check, not an ``isinstance`` gate —
so the SPI stays a plain ``Protocol``. A target adapter that reads ``config.key`` is never
imported here; that two-piece selection lives in the target modules.
"""

from __future__ import annotations

from collections.abc import Mapping

from .adapter import AnalyticsAdapter
from .config import AnalyticsConfig
from .noop import NoopAdapter
from .provider import Analytics


def create_analytics(
    config: AnalyticsConfig | Mapping[str, object],
    adapter: AnalyticsAdapter | None = None,
) -> Analytics:
    """Build a provider from configuration, injecting ``adapter`` or the silent no-op.

    ``config`` is parsed and validated as an :class:`AnalyticsConfig` (the one inbound
    boundary). When no adapter is supplied the provider is the whole-stack no-op — a working
    but silent stack obtained by config alone.
    """
    parsed = AnalyticsConfig.model_validate(config)
    resolved = adapter if adapter is not None else NoopAdapter()
    allowlist = frozenset(parsed.allowlist) if parsed.allowlist is not None else None
    return Analytics(
        resolved,
        super_properties=parsed.super_properties,
        allowlist=allowlist,
        on_violation=parsed.on_violation,
    )
