"""The flag client's own inbound config boundary — DISTINCT from ingest and query config.

``FlagClientConfig`` is server-only and deliberately separate from the ingest
:class:`~analytics_kit.AnalyticsConfig` and the read-side
:class:`~analytics_kit.QueryClientConfig`: the flag-eval round-trip authenticates its OWN
``key`` against its OWN ``flag_endpoint``, neither of which aliases the ingest write ``key`` /
``ingest_host``. A flag-eval credential and an ingest write key are different credentials with
different scopes, kept apart by construction — the same separation the query client enforces
for its personal read key. This lets a future non-vendor flag backend supply a distinct
flag-eval credential and endpoint while satisfying the SAME neutral ``FeatureFlagPort``.

``bootstrap`` reuses the neutral :class:`~analytics_kit.FlagBootstrap` type — the server path
is remote-round-trip-primary, so bootstrap is a minimal SSR request-scoped seed/fallback, not a
client-style flash guard. It carries the SAME ``model_config`` posture as the ingest config:
``extra="forbid"`` so a config typo raises loudly, and ``arbitrary_types_allowed`` so
``taxonomy``/``transport`` are held opaque via the same ``isinstance`` guards.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict

from ..config import FlagBootstrap
from ..taxonomy import Taxonomy
from .transport import FlagTransport


class FlagClientConfig(BaseModel):
    """The consumer-supplied flag-eval configuration the flag factory parses.

    ``key`` presence drives selection: unkeyed (or keyed-but-endpointless) configuration yields
    the null-object flag client (bar B). ``flag_endpoint`` is the config-supplied flag-eval
    origin the round-trip POSTs to — a single endpoint (mirroring ``query_endpoint``), NOT the
    split ``ingest_host``/``ingest_path`` of the ingest path. ``bootstrap`` is the neutral
    server-rendered seed served as a fallback when a round-trip fails. ``taxonomy`` is the
    :func:`~analytics_kit.define_taxonomy` return value, held opaque via
    ``arbitrary_types_allowed``. ``transport`` is the injectable HTTP send hook the adapter
    routes the round-trip through (default ``None`` — the adapter supplies a stdlib transport
    when unset). Unknown keys are rejected loudly.

    The local-eval knobs — ``definitions_endpoint``, ``definitions_key``, ``poll_interval``,
    ``only_evaluate_locally``, ``strict_local_evaluation`` — are ADAPTER config, never neutral port
    surface: a config supplying a definitions endpoint + the privileged ``definitions_key`` selects
    the local-capable adapter (poll definitions, evaluate in-process, fall back to the remote
    round-trip). ``definitions_key`` is the privileged (definition-reading) credential, named BY ROLE
    and DISTINCT from the ingest write key and the flag-eval ``key``. Enabling/tuning local eval is
    config-only (bar B). Because ``extra="forbid"``, these are real fields — a local-eval config with
    an unknown key still raises loudly.
    """

    model_config = ConfigDict(extra="forbid", arbitrary_types_allowed=True)

    key: str | None = None
    flag_endpoint: str | None = None
    bootstrap: FlagBootstrap | None = None
    taxonomy: Taxonomy | None = None
    transport: FlagTransport | None = None
    definitions_endpoint: str | None = None
    definitions_key: str | None = None
    poll_interval: float | None = None
    only_evaluate_locally: bool | None = None
    strict_local_evaluation: bool | None = None
