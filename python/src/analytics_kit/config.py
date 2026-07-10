"""The inbound config boundary — validated with Pydantic.

Config is the one genuine inbound boundary: consumer-supplied and untrusted-ish, so it is
parsed and validated. The neutral event, wire envelope, and internal data stay plain
dataclasses/TypedDicts — library-built and trusted-by-construction. ``AnalyticsConfig``
carries only what the seam needs today; later cycles extend it additively (taxonomy and
allowlist, ingest endpoint and queue tuning, the query config).
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict

from .allowlist import ViolationPolicy
from .taxonomy import Taxonomy


class AnalyticsConfig(BaseModel):
    """The consumer-supplied configuration the factory parses.

    ``key`` presence drives adapter selection: unkeyed configuration yields a whole-stack
    silent no-op. ``super_properties`` are merged into every captured event by the provider.
    ``sync_mode`` selects the delivery posture: ``True`` delivers inline (no background
    thread); ``False`` (default) offloads delivery to a background daemon thread. The flag
    is the contract only — both delivery paths are wired in the server-capture cycle.
    ``allowlist`` is the consumer-supplied payload allowlist (``None`` ⇒ inactive; an
    explicit empty list ⇒ allow-nothing); ``on_violation`` selects the enforcement policy.
    ``taxonomy`` is the :func:`define_taxonomy` return value — an opaque, non-Pydantic
    object held via an ``isinstance(value, Taxonomy)`` check (``arbitrary_types_allowed``),
    so a raw dict fails at this boundary rather than with an ``AttributeError`` later.
    Supplying a taxonomy never auto-activates the allowlist. ``ingest_host``/``ingest_path``
    are the split ingest-endpoint fields the server target reads (a host and a path, never a
    single combined endpoint); there is no vendor default, so an absent ``ingest_host`` is a
    consumer misconfiguration. ``flush_at``/``flush_interval``/``max_batch_size``/
    ``max_queue_size`` tune the server batch consumer (buffer size trigger, interval trigger in
    seconds, max records per delivery, max buffered events); unset uses the locked defaults.
    ``shutdown_timeout`` bounds the drain ``shutdown()`` races against (seconds) before it
    settles deterministically; ``retry_count``/``retry_delay`` bound the fixed-delay transient
    retry budget on delivery (``retry_count`` retries after the first attempt ⇒ ``retry_count + 1``
    total attempts, each spaced by ``retry_delay`` seconds). Unknown keys are rejected loudly — a
    config typo raises rather than silently degrading.
    """

    model_config = ConfigDict(extra="forbid", arbitrary_types_allowed=True)

    key: str | None = None
    super_properties: dict[str, object] | None = None
    sync_mode: bool = False
    allowlist: list[str] | None = None
    on_violation: ViolationPolicy = "throw"
    taxonomy: Taxonomy | None = None
    ingest_host: str | None = None
    ingest_path: str | None = None
    flush_at: int = 20
    flush_interval: float = 10.0
    max_batch_size: int = 100
    max_queue_size: int = 1000
    shutdown_timeout: float = 30.0
    retry_count: int = 3
    retry_delay: float = 3.0
