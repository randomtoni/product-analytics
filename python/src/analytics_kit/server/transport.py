"""The adapter-owned transport — the gzipped batch delivery below the neutral seam.

The neutral SPI ``send(url, method, headers, body: str | None)`` is the STRING-bodied transport
primitive; the gzipped BATCH delivery deliberately does NOT route through it (binary bodies live
below the SPI). Instead the server adapter owns this private transport path: it maps each batch
to the wire envelope, gzips it, and POSTs it to the config-supplied endpoint.

The transport itself is injectable on the adapter constructor, typed against the minimal
adapter-owned :class:`Transport` protocol (the analog of an injectable HTTP session) — never a
vendor or third-party library type, so no ``requests.Session``-style handle leaks across the
seam. The default :class:`UrllibTransport` is stdlib-only (zero new dependency). All wire
vocabulary — the gzip content headers, the default ``/batch/`` path — is ``_WIRE_*``-confined
here, never on the neutral surface.
"""

from __future__ import annotations

import gzip
import json
import urllib.request
from datetime import datetime, timezone
from typing import Protocol

from ..adapter import NeutralResponse
from ..config import AnalyticsConfig
from ..neutral_event import NeutralEvent
from .consumer import DeliverBatch
from .wire_mapper import assemble_batch_envelope

# Wire transport vocabulary — adapter-internal, never on the neutral surface.
_WIRE_CONTENT_TYPE_HEADER = "Content-Type"
_WIRE_CONTENT_TYPE = "application/json"
_WIRE_CONTENT_ENCODING_HEADER = "Content-Encoding"
_WIRE_CONTENT_ENCODING_GZIP = "gzip"
_WIRE_METHOD_POST = "POST"

# The ``/batch/``-style ingest path, used only when the consumer does not override
# ``ingest_path``. There is NO vendor host default: an absent ``ingest_host`` is a consumer
# misconfiguration, never a silent fall-through to a vendor endpoint.
_WIRE_DEFAULT_INGEST_PATH = "/batch/"


class Transport(Protocol):
    """The adapter-owned HTTP send seam — a minimal ``post`` the batch delivery routes through.

    Injectable so a consumer can supply a first-party client / proxy; typed against this
    protocol so no vendor or third-party library handle crosses the seam.
    """

    def post(self, url: str, headers: dict[str, str], body: bytes) -> NeutralResponse:
        """POST ``body`` to ``url`` with ``headers``; return the neutral response."""
        ...


class UrllibTransport:
    """The default transport — a stdlib ``urllib`` POST (zero new dependency)."""

    def post(self, url: str, headers: dict[str, str], body: bytes) -> NeutralResponse:
        request = urllib.request.Request(url, data=body, headers=headers, method=_WIRE_METHOD_POST)
        with urllib.request.urlopen(request) as response:  # noqa: S310
            return NeutralResponse(status=response.status, body=response.read().decode("utf-8"))


def _gzip_body(payload: str) -> tuple[bytes, bool]:
    """Gzip the JSON payload deterministically; fall back to raw bytes if gzip yields nothing.

    Returns the body bytes and whether they are gzipped (drives the ``Content-Encoding`` header).
    ``mtime=0`` zeroes the gzip header's wall-clock for reproducible output.
    """
    raw = payload.encode("utf-8")
    compressed = gzip.compress(raw, mtime=0)
    if compressed:
        return compressed, True
    return raw, False


def resolve_endpoint(config: AnalyticsConfig) -> str:
    """Resolve the ingest endpoint from config host + path. No vendor host is ever defaulted."""
    host = (config.ingest_host or "").rstrip("/")
    path = config.ingest_path if config.ingest_path is not None else _WIRE_DEFAULT_INGEST_PATH
    return f"{host}{path}"


def create_send_batch(config: AnalyticsConfig, transport: Transport) -> DeliverBatch:
    """Build the delivery callback the batch consumer hands each sliced batch to.

    The returned callback owns HOW a batch leaves: map to the wire envelope, gzip, and POST
    through the injected transport. It closes over the resolved endpoint + api_key so the
    consumer stays wire-agnostic. Happy-path only this story — the retry/normalization/413
    hardening rides the reliability slice.
    """
    url = resolve_endpoint(config)
    api_key = config.key or ""

    def deliver(batch: list[NeutralEvent]) -> None:
        sent_at = datetime.now(timezone.utc).isoformat()
        payload = json.dumps(assemble_batch_envelope(api_key, batch, sent_at))
        body, gzipped = _gzip_body(payload)
        headers = {_WIRE_CONTENT_TYPE_HEADER: _WIRE_CONTENT_TYPE}
        if gzipped:
            headers[_WIRE_CONTENT_ENCODING_HEADER] = _WIRE_CONTENT_ENCODING_GZIP
        transport.post(url, headers, body)

    return deliver
