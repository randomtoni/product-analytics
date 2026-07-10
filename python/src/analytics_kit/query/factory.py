"""The config-selected query factory — bar B for the read surface.

``create_query_client`` is how a consumer wires a read client by configuration alone. Selection
mirrors the ingest factory's shape and the TS ``create-query-client`` split:

- no ``personal_key`` (or a key set but no ``query_endpoint``) ⇒ the silent :class:`QueryNoop`
  (bar B — an unconfigured environment queries nothing, never an exception);
- ``personal_key`` + ``query_endpoint`` present ⇒ the HTTP query adapter branch.

The personal key is DISTINCT from the ingest write key and is read only here, server-side. The
HTTP-adapter branch is the seam PY5-S2 fills: S1 wires the selection and the branch, S2 supplies
the adapter body (spec→wire, POST, sync-blocking poll, Pydantic wire→result decode). Until then
the branch raises loudly so a misconfiguration never silently degrades to a no-op.
"""

from __future__ import annotations

from .client import AnalyticsQueryClient
from .config import QueryClientConfig
from .noop import QueryNoop


def create_query_client(config: QueryClientConfig) -> AnalyticsQueryClient:
    """Build a read client from configuration, selecting the no-op or the HTTP adapter.

    Unkeyed (or keyed-but-endpointless) yields the whole-surface no-op; a keyed + endpointed
    config selects the HTTP query adapter (PY5-S2 fills that branch).
    """
    if config.personal_key is None or config.query_endpoint is None:
        return QueryNoop()
    return _build_http_query_client(config)


def _build_http_query_client(config: QueryClientConfig) -> AnalyticsQueryClient:
    """The keyed + endpointed selection branch — the HTTP query adapter seam PY5-S2 fills.

    S2 replaces this body with the ``HttpQueryAdapter`` construction (reading
    ``query_endpoint``/``personal_key``/``project_id``/``transport`` off ``config``), returning
    an :class:`AnalyticsQueryClient` unchanged. The factory's selection above is stable; only
    this branch's body lands in S2.
    """
    raise NotImplementedError(
        "analytics-kit: the HTTP query adapter is not implemented yet (PY5-S2)"
    )
