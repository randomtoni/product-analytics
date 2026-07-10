"""Regression: the real ``urllib`` transport must surface HTTP error STATUSES, not swallow them to 0.

``urllib.request.urlopen`` RAISES ``HTTPError`` for every non-2xx response (unlike ``fetch``, which
resolves with the status). The reliability layer classifies on the returned status — so a raise that
normalized to a transient ``0`` made a permanent ``400`` look transient (retried then dropped) and
left ``413``-halving dead. These drive the REAL transport over a REAL loopback socket returning a
chosen status — the gap the return-status fake transports (``test_server_reliability.py``) can't cover
and the 503-only real-stack probe missed (503 is transient whether it returns 503 or normalizes to 0).
"""

from __future__ import annotations

import gzip
import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import pytest

from analytics_kit import AnalyticsConfig
from analytics_kit.neutral_event import NeutralEvent
from analytics_kit.server.adapter import ServerAdapter
from analytics_kit.server.transport import UrllibTransport, create_send_batch


class _StatusServer:
    """A localhost server replying with a status decided from the posted batch record-count.

    ``status_for_size`` maps a batch size → status (default otherwise), so a 413-halving test can
    drive the shrink by the per-slice size over a real socket. A non-batch body counts as size 0.
    """

    def __init__(self, *, status_for_size: dict[int, int] | None = None, default: int = 200) -> None:
        self.request_sizes: list[int] = []
        self._status_for_size = status_for_size or {}
        self._default = default
        recorder = self

        class _Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler naming.
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length)
                if self.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                try:
                    payload = json.loads(raw.decode("utf-8")) if raw else {}
                    size = len(payload.get("batch", [])) if isinstance(payload, dict) else 0
                except (ValueError, TypeError):
                    size = 0
                recorder.request_sizes.append(size)
                self.send_response(recorder._status_for_size.get(size, recorder._default))
                self.end_headers()

            def log_message(self, *_args: Any) -> None:  # noqa: A002 — silence the server log.
                pass

        self._server = HTTPServer(("127.0.0.1", 0), _Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def host(self) -> str:
        address, port = self._server.server_address[:2]
        host = address.decode() if isinstance(address, bytes) else address
        return f"http://{host}:{port}"

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)


@pytest.fixture
def status_server() -> Iterator[_StatusServer]:
    server = _StatusServer()
    try:
        yield server
    finally:
        server.close()


def _event(tag: str) -> NeutralEvent:
    return NeutralEvent(event=tag, distinct_id="u1", dedupe_id=tag)


class _NoWait:
    def __init__(self) -> None:
        self.waits: list[float] = []

    def __call__(self, seconds: float) -> None:
        self.waits.append(seconds)


# --- unit-level: UrllibTransport.post returns the REAL status on a non-2xx (Finding 1) -------


@pytest.mark.parametrize("status", [400, 404, 413, 422, 429, 500, 503])
def test_urllib_transport_returns_the_real_http_status_not_zero(status: int) -> None:
    server = _StatusServer(default=status)
    try:
        response = UrllibTransport().post(
            f"{server.host}/batch/", {"Content-Type": "application/json"}, b"{}"
        )
        # The raised HTTPError's code is surfaced, NOT swallowed to a transient 0.
        assert response.status == status
    finally:
        server.close()


def test_urllib_transport_network_failure_still_propagates_for_boundary_normalization() -> None:
    # A genuine network failure (no HTTP status) must still RAISE out of post — the delivery
    # boundary (post_envelope) normalizes THAT to 0. Only HTTP statuses are caught in post.
    with pytest.raises(Exception):  # noqa: B017, PT011 — any raised transport error; the point is it propagates.
        UrllibTransport().post("http://127.0.0.1:1/batch/", {}, b"{}")


# --- end-to-end over a real socket: the reliability layer now classifies real statuses -------


def test_permanent_400_over_the_real_socket_is_dropped_not_retried() -> None:
    server = _StatusServer(default=400)
    wait = _NoWait()
    try:
        deliver = create_send_batch(
            AnalyticsConfig(key="k", ingest_host=server.host, retry_count=3), UrllibTransport(), wait=wait
        )
        deliver([_event("e0")])
        # 400 is permanent: exactly one real request, no retries, no backoff waits (was retried 4×).
        assert len(server.request_sizes) == 1
        assert wait.waits == []
    finally:
        server.close()


def test_413_over_the_real_socket_halves_and_resends_the_same_records() -> None:
    # A 4-record slice 413s, a 2-record slice 413s, a 1-record slice 200s: 4 → 2+2 → 1+1+1+1.
    server = _StatusServer(status_for_size={4: 413, 2: 413}, default=200)
    try:
        deliver = create_send_batch(
            AnalyticsConfig(key="k", ingest_host=server.host, max_batch_size=4), UrllibTransport(), wait=_NoWait()
        )
        deliver([_event(f"e{i}") for i in range(4)])
        # The real 413s drove halving over the socket — dead before the fix (413 normalized to 0).
        assert server.request_sizes[0] == 4
        assert 2 in server.request_sizes
        assert server.request_sizes.count(1) == 4  # every record ultimately delivered at size 1
    finally:
        server.close()


def test_transient_503_over_the_real_socket_is_retried_within_budget() -> None:
    server = _StatusServer(default=503)
    wait = _NoWait()
    try:
        deliver = create_send_batch(
            AnalyticsConfig(key="k", ingest_host=server.host, retry_count=2), UrllibTransport(), wait=wait
        )
        deliver([_event("e0")])
        assert len(server.request_sizes) == 3  # 1 initial + 2 retries
        assert len(wait.waits) == 2
    finally:
        server.close()


# --- Finding 3: ServerAdapter.send is now a real neutral primitive, not an inert stub --------


def test_server_adapter_send_does_a_real_round_trip() -> None:
    server = _StatusServer(default=200)
    try:
        adapter = ServerAdapter(version="9.9.9")
        response = adapter.send(f"{server.host}/x", "POST", {"Content-Type": "application/json"}, "{}")
        assert response.status == 200
        assert len(server.request_sizes) == 1  # a real request actually left over the socket
    finally:
        server.close()


def test_server_adapter_send_surfaces_a_real_error_status() -> None:
    server = _StatusServer(default=404)
    try:
        response = ServerAdapter(version="9.9.9").send(f"{server.host}/x", "POST", {}, "{}")
        assert response.status == 404  # the HTTPError code, not a swallowed 0
    finally:
        server.close()
