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
import time
import urllib.error
import urllib.request
from collections.abc import Callable
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

_STATUS_NO_RESPONSE = 0
_STATUS_REQUEST_TIMEOUT = 408
_STATUS_TOO_MANY_REQUESTS = 429
_STATUS_SERVER_ERROR_FLOOR = 500
_STATUS_PAYLOAD_TOO_LARGE = 413

Wait = Callable[[float], None]
"""The retry-delay wait, injectable so retry tests short-circuit it instead of sleeping."""


def _is_transient_status(status: int) -> bool:
    """Transient ⇒ retry within budget: no-response (``0``), ``408``, ``429``, or any ``5xx``.

    A non-413 ``4xx`` is a permanent rejection (dropped, not retried); ``413`` is handled by the
    caller's halving, never as a retry-backoff status.
    """
    return (
        status == _STATUS_NO_RESPONSE
        or status == _STATUS_REQUEST_TIMEOUT
        or status == _STATUS_TOO_MANY_REQUESTS
        or status >= _STATUS_SERVER_ERROR_FLOOR
    )


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
        try:
            with urllib.request.urlopen(request) as response:  # noqa: S310
                return NeutralResponse(status=response.status, body=response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            # urllib RAISES HTTPError for every non-2xx (unlike fetch, which resolves with the
            # status). Return its real status so the retry classifier + 413-halving see 400/413/5xx
            # instead of the raise normalizing to a transient 0. Genuine network errors (no HTTP
            # status — connection/DNS/bad-URL) still propagate to post_envelope's boundary → 0.
            return NeutralResponse(status=error.code, body=error.read().decode("utf-8", errors="replace"))


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


def create_send_batch(
    config: AnalyticsConfig,
    transport: Transport,
    *,
    wait: Wait | None = None,
) -> DeliverBatch:
    """Build the delivery callback the batch consumer hands each sliced batch to.

    The returned callback owns HOW a batch leaves: map to the wire envelope, gzip, POST through
    the injected transport, and carry the reliability guarantees around that POST — fetch-failure
    normalization, transient retry within a fixed-delay budget, and 413-halving of the in-flight
    slice. It closes over the resolved endpoint + api_key so the consumer stays wire-agnostic.

    ``wait`` (default a real ``time.sleep``) is the retry-delay pause, injectable so retry tests
    short-circuit it instead of sleeping real seconds.
    """
    url = resolve_endpoint(config)
    api_key = config.key or ""
    configured_max_batch_size = max(config.max_batch_size, 1)
    retry_count = max(config.retry_count, 0)
    retry_delay = config.retry_delay
    sleep: Wait = wait if wait is not None else time.sleep

    def post_envelope(events: list[NeutralEvent]) -> int:
        """Map, gzip, and POST one slice; return the wire status.

        A raised transport (connection error, timeout, DNS failure, any HTTP-client exception) is
        normalized to status ``0`` at THIS boundary — it never leaks a raw ``urllib``/vendor
        exception onto the neutral surface. The retry classifier treats ``0`` as transient.
        """
        sent_at = datetime.now(timezone.utc).isoformat()
        payload = json.dumps(assemble_batch_envelope(api_key, events, sent_at))
        body, gzipped = _gzip_body(payload)
        headers = {_WIRE_CONTENT_TYPE_HEADER: _WIRE_CONTENT_TYPE}
        if gzipped:
            headers[_WIRE_CONTENT_ENCODING_HEADER] = _WIRE_CONTENT_ENCODING_GZIP
        try:
            return transport.post(url, headers, body).status
        except Exception:  # noqa: BLE001 — normalize ANY transport failure to a transient status.
            return _STATUS_NO_RESPONSE

    def send_with_retry(events: list[NeutralEvent]) -> int:
        """POST one slice, retrying transient failures within the fixed-delay budget.

        ``413`` is NOT retried here (the caller halves and re-sends); a non-413 ``4xx`` is
        permanent. Returns the final status — never raises out to the consumer.
        """
        status = post_envelope(events)
        for _ in range(retry_count):
            if status == _STATUS_PAYLOAD_TOO_LARGE or not _is_transient_status(status):
                return status
            sleep(retry_delay)
            status = post_envelope(events)
        return status

    def deliver(batch: list[NeutralEvent]) -> None:
        """Deliver ``batch``, re-slicing at ``max_batch_size`` and shrinking it on a ``413``.

        413-halving is PER-DELIVERY: the smaller size re-slices THESE records in flight and is
        never written back to the queue config; records are never dropped on a 413 — only re-sent
        smaller. The one exception is the terminal case — a SINGLE record that still ``413``\\ s
        cannot be halved further, so it is dropped and the rest continue (no infinite loop).
        """
        max_batch_size = configured_max_batch_size
        pending = batch
        while pending:
            slice_ = pending[:max_batch_size]
            status = send_with_retry(slice_)
            if status == _STATUS_PAYLOAD_TOO_LARGE:
                if len(slice_) <= 1:
                    pending = pending[len(slice_) :]
                    continue
                max_batch_size = max(1, len(slice_) // 2)
                continue
            pending = pending[len(slice_) :]

    return deliver
