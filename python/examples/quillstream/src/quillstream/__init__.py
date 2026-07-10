"""Quillstream — an example server-shaped SaaS that adopts analytics-kit by config alone.

This package holds every product specific (taxonomy, config, the recording test double, and the
adoption harness). It imports only the public ``analytics_kit`` namespace — the proof that a new
app adopts the library without any library change (bar B).
"""

from __future__ import annotations

from .config import quillstream_config, quillstream_query_config
from .harness import QuillstreamHarness, create_quillstream_analytics
from .recording_adapter import RecordingAdapter
from .taxonomy import quillstream_taxonomy

__all__ = [
    "quillstream_taxonomy",
    "quillstream_config",
    "quillstream_query_config",
    "RecordingAdapter",
    "QuillstreamHarness",
    "create_quillstream_analytics",
]
