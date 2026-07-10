"""The neutral event substrate — the one artifact that crosses the adapter seam.

``NeutralEvent`` is a plain dataclass: it is library-built and trusted-by-construction,
so it carries no runtime validation (Pydantic lives only at the config-parse boundary).
Server-scoped by design — the browser-only substrate fields (``session_id``,
``is_page_view``, per-event enrichment) have no server home and are deliberately absent.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

NeutralProperties = dict[str, object]
"""The neutral property bag carried on an event and reused by the trait paths."""

NeutralTraits = NeutralProperties
"""The trait shape the identify/group paths reuse — structurally a property bag."""

InternalKind = Literal["set_traits", "set_group_traits", "group_identify"]
"""Structural discriminant for provider-minted internal events (server-relevant kinds only).

Browser-only kinds (autocapture, page-leave, anonymous-merge) have no server home and are
not declared here. Adapter-side normalization keys off this discriminant, never the event
name — so a consumer event literally named ``set_traits`` is never mistaken for an internal
event.
"""


@dataclass
class NeutralEvent:
    """A single captured event in neutral form.

    Field order is load-bearing: a plain dataclass synthesizes a positional ``__init__``,
    so the three required fields (``event``, ``distinct_id``, ``dedupe_id``) must precede
    the defaulted ones. ``internal_kind`` marks a provider-minted internal event; it is
    ``None`` for every consumer capture.
    """

    event: str
    distinct_id: str
    dedupe_id: str
    properties: NeutralProperties | None = None
    timestamp: datetime | None = None
    internal_kind: InternalKind | None = None
