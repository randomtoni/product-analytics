"""The server target — the ``config.key`` half of the two-piece adapter selection.

The seam ``create_analytics`` is deliberately generic and imports no target adapter; this
target module completes the selection: it reads ``config.key`` and, when present, builds the
:class:`ServerAdapter` and injects it into the provider. When absent, it defers to the seam
default — the whole-stack silent :class:`~analytics_kit.NoopAdapter` (unkeyed ⇒ silent). The
delivery machinery (queue, thread, transport) lives only under this target, never in the
fenced seam modules.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping

from ..config import AnalyticsConfig
from ..factory import create_analytics
from ..flags import FlagClientConfig, create_flag_client
from ..provider import Analytics
from ..version import __version__
from .adapter import ServerAdapter
from .consumer import BatchConsumer
from .transport import Transport, UrllibTransport, create_send_batch

_logger = logging.getLogger("analytics_kit")

__all__ = [
    "BatchConsumer",
    "ServerAdapter",
    "Transport",
    "UrllibTransport",
    "create_server_analytics",
]


def create_server_analytics(
    config: AnalyticsConfig | Mapping[str, object],
) -> Analytics:
    """Build a server provider by config alone: keyed ⇒ the server adapter, unkeyed ⇒ silent.

    ``config.key`` presence drives selection. With a key, the :class:`ServerAdapter` is built
    and injected into the provider through the seam factory; the batch consumer's delivery
    callback is the gzip→POST path built from the adapter-owned transport (default stdlib
    ``urllib``). Without a key, the seam factory's own default applies — a whole-stack
    :class:`~analytics_kit.NoopAdapter`, so an unconfigured environment sends nothing (bar B)
    with zero library change.

    The provider's ``flags`` slot is populated when a ``key`` is set alongside a
    ``flags.flag_endpoint``: the flag client is built from the ingest ``key`` + the flag-eval
    endpoint (a two-piece selection reading ``config.key`` here in the target, never in the
    fenced seam factory) and set on the returned provider. Absent a flag endpoint the slot stays
    the ``None`` default — feature-flags stay off by config alone (bar B). A consumer wanting a
    distinct flag credential/endpoint uses the standalone :func:`~analytics_kit.create_flag_client`.
    """
    parsed = AnalyticsConfig.model_validate(config)
    if parsed.key is None:
        return create_analytics(parsed)
    if not parsed.ingest_host:
        _logger.warning(
            "a key is set but no ingest_host is configured; every batch will POST to a host-less "
            "URL, fail, and be dropped. Set ingest_host."
        )
    transport = UrllibTransport()
    consumer = BatchConsumer(
        create_send_batch(parsed, transport),
        sync_mode=parsed.sync_mode,
        flush_at=parsed.flush_at,
        flush_interval=parsed.flush_interval,
        max_batch_size=parsed.max_batch_size,
        max_queue_size=parsed.max_queue_size,
        shutdown_timeout=parsed.shutdown_timeout,
    )
    adapter = ServerAdapter(version=__version__, sink=consumer, transport=transport)
    analytics = create_analytics(parsed, adapter=adapter)
    _attach_flags(analytics, parsed)
    return analytics


def _attach_flags(analytics: Analytics, config: AnalyticsConfig) -> None:
    """Populate the provider's ``flags`` slot when a flag-eval OR a local-eval endpoint is configured.

    Builds the flag client from the ingest ``key`` + ``config.flags`` (the remote ``flag_endpoint``,
    the local-eval knobs, the neutral bootstrap seed + taxonomy). The slot is attached when a
    ``flag_endpoint`` OR a ``definitions_endpoint`` is present — the latter is the local-only posture
    (in-process eval with no remote round-trip). Without either the slot stays the ``None`` default —
    the flag client is only wired when the consumer opts in by config.
    """
    flags = config.flags
    if flags is None or (flags.flag_endpoint is None and flags.definitions_endpoint is None):
        return
    analytics.flags = create_flag_client(
        FlagClientConfig(
            key=config.key,
            flag_endpoint=flags.flag_endpoint,
            bootstrap=flags.bootstrap,
            taxonomy=config.taxonomy,
            definitions_endpoint=flags.definitions_endpoint,
            definitions_key=flags.definitions_key,
            poll_interval=flags.poll_interval,
            only_evaluate_locally=flags.only_evaluate_locally,
            strict_local_evaluation=flags.strict_local_evaluation,
        )
    )
