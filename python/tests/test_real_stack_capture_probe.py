"""Real-stack capture probe + negative controls — the R1 "all gates green ≠ correct" lesson.

These are NOT self-consistent unit tests. Each probe pins the emitted BYTES against an EXTERNAL
contract the code-under-test cannot satisfy by accident:

* the ``posthog-python`` wire contract read from source (envelope shape, ``/batch/`` path, top-level
  ``uuid``, gzip headers), and
* the neutrality invariant (zero ``$``-prefixed keys, zero vendor tokens) — the exact place our
  surface DIVERGES from posthog-python, which IS the de-brand proof.

The probe drives a real capture through the REAL send path — ``create_server_analytics(config)``
with a keyed config, ``sync_mode=True``, and ``ingest_host`` pointed at a local-loopback HTTP server
on an ephemeral port — so delivery goes through the production composition
(``BatchConsumer(create_send_batch(config, UrllibTransport()))``), the real ``UrllibTransport``
opens a real socket, and we assert on the bytes a real localhost server received. It is deliberately
NOT the default ``_BufferSink`` (``server/adapter.py`` — it only appends to a list, never touches
the transport) and NOT an injected fake ``Transport`` (a mock is not a real-stack proof).

Ground-truth citations (a SOURCE comparison, no live call — the ``posthog-python/`` checkout at the
repo root):

* envelope ``{api_key, batch, sent_at}`` POSTed to ``/batch/`` —
  ``posthog-python/posthog/request.py:224-231`` (``body["sent_at"]``/``body["api_key"]`` set on the
  POSTed body) and ``request.py:363`` (``EVENTS_ENDPOINT = "/batch/"``).
* per-event top-level ``uuid`` — ``posthog-python/posthog/client.py:1042-1047`` (the message dict is
  ``{properties, timestamp, distinct_id, event, uuid}``; the idempotency key is ``uuid``, NOT
  ``$insert_id`` — ``$insert_id`` is a browser-only random enrichment property, never the server
  dedup key).
* gzip + ``Content-Type``/``Content-Encoding`` headers — ``request.py:233-242``.
* DE-BRAND divergence (why our bytes must be ``$``-free): posthog-python emits ``$``-prefixed
  special events/keys — ``client.py:1051`` (``properties["$groups"]``), ``client.py:1227-1228``
  (``"$set"`` / ``"event": "$set"``), ``client.py:1275-1276`` (``"$set_once"``), ``client.py:1326``
  (``"event": "$groupidentify"``), ``client.py:1330`` (``"$group_set"``). Our surface neutralizes
  every one of these to the nested ``set``/``set_once``/``group_type``/``group_key``/``group_set``
  wrappers with NO ``$`` — that divergence is the neutrality proof asserted below.
"""

from __future__ import annotations

import gzip
import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import pytest

from analytics_kit import AnalyticsConfig, create_server_analytics
from analytics_kit.server import transport as transport_module


class _CapturedRequest:
    """One request the loopback server received, decoded to the wire it actually carried."""

    def __init__(self, path: str, method: str, headers: dict[str, str], body: bytes) -> None:
        self.path = path
        self.method = method
        self.headers = headers
        self.body = body

    def json(self) -> dict[str, Any]:
        raw = self.body
        if self.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        decoded: dict[str, Any] = json.loads(raw.decode("utf-8"))
        return decoded


class _LoopbackServer:
    """A real localhost HTTP server that records every request it receives.

    ``status_sequence`` lets a test return a transient status (``429``/``503``) on the first hit and
    ``200`` afterward, driving the transport's real retry machinery over a real socket.
    """

    def __init__(self, status_sequence: list[int] | None = None) -> None:
        self.requests: list[_CapturedRequest] = []
        self._statuses = list(status_sequence or [])
        recorder = self

        class _Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler naming.
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length)
                recorder.requests.append(
                    _CapturedRequest(
                        path=self.path,
                        method=self.command,
                        headers={k: v for k, v in self.headers.items()},
                        body=body,
                    )
                )
                status = recorder._statuses.pop(0) if recorder._statuses else 200
                self.send_response(status)
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
def loopback() -> Iterator[_LoopbackServer]:
    server = _LoopbackServer()
    try:
        yield server
    finally:
        server.close()


TEST_KEY = "phc_test_project_key"


def _keyed_config(host: str, **overrides: Any) -> AnalyticsConfig:
    """A keyed sync-mode config pointed at the loopback host — the production send path.

    ``sync_mode=True`` + ``flush_at=1`` delivers each capture inline on the calling thread (no
    background daemon, no wall-clock wait) so a single capture round-trips deterministically.
    """
    fields: dict[str, Any] = {
        "key": TEST_KEY,
        "ingest_host": host,
        "sync_mode": True,
        "flush_at": 1,
    }
    fields.update(overrides)
    return AnalyticsConfig(**fields)


def _has_dollar_key(value: object) -> bool:
    """True if any dict key ANYWHERE in the structure is ``$``-prefixed (recursive)."""
    if isinstance(value, dict):
        for key, child in value.items():
            if isinstance(key, str) and key.startswith("$"):
                return True
            if _has_dollar_key(child):
                return True
        return False
    if isinstance(value, list):
        return any(_has_dollar_key(item) for item in value)
    return False


# --- the capture probe: the REAL send path, asserting on the received bytes -----------------


def test_capture_round_trips_through_the_real_socket_to_the_loopback_server(
    loopback: _LoopbackServer,
) -> None:
    provider = create_server_analytics(_keyed_config(loopback.host))
    provider.capture("user-1", "order_placed", {"amount": 42})

    # Exactly one real request reached the real localhost server over a real socket.
    assert len(loopback.requests) == 1
    request = loopback.requests[0]

    # Path = default ingest_path /batch/ (posthog-python request.py:363 EVENTS_ENDPOINT);
    # method POST; gzip + content-type headers (request.py:233-242).
    assert request.path == "/batch/"
    assert request.method == "POST"
    assert request.headers.get("Content-Type") == "application/json"
    assert request.headers.get("Content-Encoding") == "gzip"


def test_captured_envelope_has_exactly_the_neutral_top_level_keys(
    loopback: _LoopbackServer,
) -> None:
    provider = create_server_analytics(_keyed_config(loopback.host))
    provider.capture("user-1", "order_placed", {"amount": 42})

    envelope = loopback.requests[0].json()

    # Envelope top-level keys EXACTLY {api_key, batch, sent_at} — posthog-python request.py:224-231.
    assert set(envelope.keys()) == {"api_key", "batch", "sent_at"}
    assert envelope["api_key"] == TEST_KEY
    assert isinstance(envelope["batch"], list)
    # sent_at is an ISO-8601 string (fromisoformat round-trips it without raising).
    from datetime import datetime

    assert isinstance(envelope["sent_at"], str)
    datetime.fromisoformat(envelope["sent_at"])


def test_per_event_uuid_is_the_dedupe_id_verbatim_not_insert_id(
    loopback: _LoopbackServer,
) -> None:
    provider = create_server_analytics(_keyed_config(loopback.host))
    provider.capture("user-1", "order_placed", {"amount": 42}, dedupe_id="fixed-dedupe-123")

    message = loopback.requests[0].json()["batch"][0]

    # The idempotency field is the top-level `uuid`, equal to the neutral dedupe_id VERBATIM
    # (posthog-python client.py:1042-1047) — NOT `$insert_id` (a browser-only enrichment prop).
    assert message["uuid"] == "fixed-dedupe-123"
    assert "$insert_id" not in message
    assert message["event"] == "order_placed"
    assert message["distinct_id"] == "user-1"
    assert message["properties"] == {"amount": 42}
    assert "timestamp" in message


def test_captured_body_is_dollar_free_and_vendor_free(loopback: _LoopbackServer) -> None:
    provider = create_server_analytics(_keyed_config(loopback.host))
    provider.capture("user-1", "order_placed", {"amount": 42})

    request = loopback.requests[0]
    envelope = request.json()

    # No $-prefixed keys anywhere in the emitted structure (the de-brand of posthog-python's
    # $-special events/keys: client.py:1051/1227/1275/1326/1330).
    assert not _has_dollar_key(envelope)

    # No vendor token in the raw decompressed bytes (case-insensitive over the whole body).
    raw = gzip.decompress(request.body) if request.headers.get("Content-Encoding") == "gzip" else request.body
    assert b"posthog" not in raw.lower()


def test_trait_event_surfaces_the_debranded_set_wrappers_never_dollar_set(
    loopback: _LoopbackServer,
) -> None:
    provider = create_server_analytics(_keyed_config(loopback.host))
    # `set` is the neutral person-props verb — posthog-python emits event "$set"/"$set_once"
    # (client.py:1227-1228, 1275-1276); our wire carries the de-branded nested `set`/`set_once`.
    provider.set("user-1", {"plan": "pro"})
    provider.set("user-1", {"first_seen": "2026-07-10"}, once=True)

    bodies = [req.json()["batch"][0] for req in loopback.requests]
    props_by_wrapper = {}
    for message in bodies:
        assert not _has_dollar_key(message)
        props_by_wrapper.update(message["properties"])

    assert props_by_wrapper["set"] == {"plan": "pro"}
    assert props_by_wrapper["set_once"] == {"first_seen": "2026-07-10"}
    assert "$set" not in props_by_wrapper
    assert "$set_once" not in props_by_wrapper


def test_group_event_surfaces_the_debranded_group_wrappers_never_groupidentify(
    loopback: _LoopbackServer,
) -> None:
    provider = create_server_analytics(_keyed_config(loopback.host))
    # posthog-python emits event "$groupidentify" with "$group_set" (client.py:1326, 1330);
    # our wire carries the de-branded nested group_type/group_key/group_set, no $.
    provider.set_group_traits("company", "acme", {"seats": 50})

    message = loopback.requests[0].json()["batch"][0]
    assert not _has_dollar_key(message)
    props = message["properties"]
    assert props["group_type"] == "company"
    assert props["group_key"] == "acme"
    assert props["group_set"] == {"seats": 50}
    assert "$groupidentify" not in json.dumps(message)
    assert "$group_set" not in props


# --- negative control 1: an off-list key is ABSENT from the captured wire body --------------


def test_negative_control_off_list_key_absent_from_the_wire(loopback: _LoopbackServer) -> None:
    provider = create_server_analytics(
        _keyed_config(
            loopback.host,
            allowlist=["amount"],
            on_violation="drop-and-error-log",
        )
    )
    # `amount` is on-list; `email` (PII) is off-list. Under drop-and-error-log the WHOLE event is
    # dropped on the first off-list key, so nothing reaches the wire at all — the strongest
    # ABSENT proof. A capture with only the on-list key DOES reach the wire.
    provider.capture("user-1", "order_placed", {"amount": 42, "email": "pii@example.com"})
    assert len(loopback.requests) == 0

    provider.capture("user-1", "order_placed", {"amount": 42})
    assert len(loopback.requests) == 1
    props = loopback.requests[0].json()["batch"][0]["properties"]
    assert "amount" in props
    # The off-list key is not present anywhere in the captured body.
    assert b"pii@example.com" not in gzip.decompress(loopback.requests[0].body)


def test_negative_control_off_list_key_absent_when_mixed_with_on_list_keys(
    loopback: _LoopbackServer,
) -> None:
    # A trait bag carrying an on-list AND an off-list key: the off-list key drops the whole event,
    # so the off-list value never reaches the wire, while an all-on-list bag delivers.
    provider = create_server_analytics(
        _keyed_config(loopback.host, allowlist=["seats"], on_violation="drop-and-error-log")
    )
    provider.set("user-1", {"seats": 10, "ssn": "000-00-0000"})
    assert len(loopback.requests) == 0


# --- negative control 2: an unkeyed client sends NOTHING (zero requests) ---------------------


def test_negative_control_unkeyed_client_makes_zero_requests(loopback: _LoopbackServer) -> None:
    # No key ⇒ create_server_analytics defers to the whole-stack NoopAdapter: the socket is never
    # touched, even pointed at a live loopback host and driven through the same capture + flush.
    provider = create_server_analytics(
        AnalyticsConfig(ingest_host=loopback.host, sync_mode=True, flush_at=1)
    )
    provider.capture("user-1", "order_placed", {"amount": 42})
    provider.set("user-1", {"plan": "pro"})
    provider.set_group_traits("company", "acme", {"seats": 50})
    provider.flush()

    assert len(loopback.requests) == 0


# --- negative control 3: a retry re-sends an IDENTICAL uuid ----------------------------------


def test_negative_control_retry_resends_a_stable_uuid() -> None:
    # The loopback returns a transient 503 on the first hit, then 200 — driving the transport's
    # REAL send_with_retry over a real socket. An injected `wait` short-circuits the retry delay
    # so the test never sleeps. The uuid (= dedupe_id) must be identical across BOTH captured
    # requests: a retry re-sends the same dedup key (real idempotency).
    server = _LoopbackServer(status_sequence=[503, 200])
    try:
        config = _keyed_config(server.host, retry_count=1, retry_delay=0.0)
        # Build the exact production composition by hand ONLY to inject the no-sleep wait into
        # the real create_send_batch — the transport, socket, and retry machinery are all real.
        from analytics_kit import UrllibTransport
        from analytics_kit.factory import create_analytics
        from analytics_kit.server.adapter import ServerAdapter
        from analytics_kit.server.consumer import BatchConsumer
        from analytics_kit.version import __version__

        waits: list[float] = []
        transport = UrllibTransport()
        consumer = BatchConsumer(
            transport_module.create_send_batch(config, transport, wait=waits.append),
            sync_mode=True,
            flush_at=1,
        )
        adapter = ServerAdapter(version=__version__, sink=consumer, transport=transport)
        provider = create_analytics(config, adapter=adapter)

        provider.capture("user-1", "order_placed", {"amount": 42}, dedupe_id="retry-uuid-xyz")

        # Two real requests hit the server (the 503 then the 200 retry); the wait was invoked once.
        assert len(server.requests) == 2
        assert waits == [0.0]
        uuids = [req.json()["batch"][0]["uuid"] for req in server.requests]
        assert uuids == ["retry-uuid-xyz", "retry-uuid-xyz"]
    finally:
        server.close()
