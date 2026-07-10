"""The server target — the ``config.key`` half of the two-piece adapter selection.

The seam ``create_analytics`` is deliberately generic and imports no target adapter; this
target module completes the selection: it reads ``config.key`` and, when present, builds the
:class:`ServerAdapter` and injects it into the provider. When absent, it defers to the seam
default — the whole-stack silent :class:`~analytics_kit.NoopAdapter` (unkeyed ⇒ silent). The
delivery machinery (queue, thread, transport) lives only under this target, never in the
fenced seam modules.
"""

from __future__ import annotations

from collections.abc import Mapping

from ..config import AnalyticsConfig
from ..factory import create_analytics
from ..provider import Analytics
from ..version import __version__
from .adapter import ServerAdapter

__all__ = ["ServerAdapter", "create_server_analytics"]


def create_server_analytics(
    config: AnalyticsConfig | Mapping[str, object],
) -> Analytics:
    """Build a server provider by config alone: keyed ⇒ the server adapter, unkeyed ⇒ silent.

    ``config.key`` presence drives selection. With a key, the :class:`ServerAdapter` is built
    and injected into the provider through the seam factory. Without one, the seam factory's
    own default applies — a whole-stack :class:`~analytics_kit.NoopAdapter`, so an unconfigured
    environment sends nothing (bar B) with zero library change.
    """
    parsed = AnalyticsConfig.model_validate(config)
    if parsed.key is None:
        return create_analytics(parsed)
    adapter = ServerAdapter(version=__version__)
    return create_analytics(parsed, adapter=adapter)
