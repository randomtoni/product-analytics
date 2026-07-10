"""The Quillstream analytics harness — config-only adoption of analytics-kit.

The one seam the product wires. A keyed config gets the in-memory recorder injected (so tests
can inspect what was captured); an unkeyed config passes NO adapter, so the library's own
default — the shipped ``NoopAdapter`` — makes the whole stack a silent no-op. The branch lives
here because ``create_analytics`` uses whatever adapter it is handed as-is; it is not a
key-driven recorder-vs-noop switch, so the harness owns the choice of whether to pass one.
"""

from __future__ import annotations

from dataclasses import dataclass

from analytics_kit import Analytics, AnalyticsConfig, create_analytics

from .config import quillstream_config
from .recording_adapter import RecordingAdapter


@dataclass
class QuillstreamHarness:
    """The wired analytics provider plus the recorder that backs it (``None`` when unkeyed)."""

    analytics: Analytics
    recorder: RecordingAdapter | None


def create_quillstream_analytics(config: AnalyticsConfig | None = None) -> QuillstreamHarness:
    """Adopt analytics-kit for Quillstream via the public factory.

    Keyed config ⇒ inject the recorder; unkeyed config ⇒ pass no adapter, so the seam-default
    ``NoopAdapter`` applies (bar B: a working-but-silent stack from configuration alone).
    """
    resolved_config = config if config is not None else quillstream_config()
    if resolved_config.key is None:
        return QuillstreamHarness(
            analytics=create_analytics(resolved_config),
            recorder=None,
        )
    recorder = RecordingAdapter()
    return QuillstreamHarness(
        analytics=create_analytics(resolved_config, adapter=recorder),
        recorder=recorder,
    )
