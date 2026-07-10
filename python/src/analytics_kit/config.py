"""The inbound config boundary — validated with Pydantic.

Config is the one genuine inbound boundary: consumer-supplied and untrusted-ish, so it is
parsed and validated. The neutral event, wire envelope, and internal data stay plain
dataclasses/TypedDicts — library-built and trusted-by-construction. ``AnalyticsConfig``
carries only what the seam needs today; later cycles extend it additively (taxonomy and
allowlist, ingest endpoint and queue tuning, the query config).
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class AnalyticsConfig(BaseModel):
    """The consumer-supplied configuration the factory parses.

    ``key`` presence drives adapter selection: unkeyed configuration yields a whole-stack
    silent no-op. ``super_properties`` are merged into every captured event by the provider.
    Unknown keys are rejected loudly — a config typo raises rather than silently degrading.
    """

    model_config = ConfigDict(extra="forbid")

    key: str | None = None
    super_properties: dict[str, object] | None = None
