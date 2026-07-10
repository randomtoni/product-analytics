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
    Supplying a taxonomy never auto-activates the allowlist. Unknown keys are rejected
    loudly — a config typo raises rather than silently degrading.
    """

    model_config = ConfigDict(extra="forbid", arbitrary_types_allowed=True)

    key: str | None = None
    super_properties: dict[str, object] | None = None
    sync_mode: bool = False
    allowlist: list[str] | None = None
    on_violation: ViolationPolicy = "throw"
    taxonomy: Taxonomy | None = None
