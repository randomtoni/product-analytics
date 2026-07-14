"""The query client's own inbound config boundary — DISTINCT from the ingest config.

``QueryClientConfig`` is server-only and deliberately separate from the ingest
:class:`~analytics_kit.AnalyticsConfig`: it reads a server personal/read key (Bearer auth)
against a config-supplied query endpoint + project scope. None of its fields alias the ingest
write ``key``/``ingest_host`` — a query read key and an ingest write key are different
credentials with different scopes, kept apart by construction. Personal-key handling is
server-side only.

It carries the SAME ``model_config`` posture as ``AnalyticsConfig``: ``extra="forbid"`` so a
config typo raises loudly rather than silently degrading, and ``arbitrary_types_allowed`` so
``taxonomy`` is held opaque via the same ``isinstance(value, Taxonomy)`` guard the ingest
config uses (a raw dict fails at THIS boundary, not with an ``AttributeError`` later).
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict

from ..taxonomy import Taxonomy
from .client import QueryTransport


class QueryClientConfig(BaseModel):
    """The consumer-supplied query configuration the factory parses.

    Selection is by field PRESENCE. ``warehouse_dsn`` is the explicit self-host signal — its
    presence selects the warehouse query adapter (the first rung), reading over the consumer's
    own Postgres rather than a query host; it shares its shape with E19's receiver-config field
    so self-host is one coherent "here's my Neon". A credential-shaped value, read at the factory
    boundary and never stored on the working adapter. Otherwise ``personal_key`` presence drives
    selection: unkeyed (or keyed-but-endpointless) configuration yields the query no-op (bar B).
    ``query_endpoint`` is the config-supplied host the HTTP adapter POSTs to; ``project_id``
    scopes the query URL. ``taxonomy`` is the :func:`~analytics_kit.define_taxonomy` return value
    — an opaque, non-Pydantic object held via ``arbitrary_types_allowed``, so a raw dict fails
    here. ``transport`` is the injectable HTTP send hook the HTTP adapter routes through (default
    ``None`` — the adapter supplies a stdlib transport when unset). Unknown keys are rejected
    loudly.
    """

    model_config = ConfigDict(extra="forbid", arbitrary_types_allowed=True)

    warehouse_dsn: str | None = None
    query_endpoint: str | None = None
    personal_key: str | None = None
    project_id: str | None = None
    taxonomy: Taxonomy | None = None
    transport: QueryTransport | None = None
