"""E12-S4 tests for the Python server remote-eval feature-flag adapter.

Every assertion runs against an INJECTED mock transport replaying canned responses (or against
the null object) — NEVER a real backend. The tests pin the server semantics carried over from the
node S3 adapter at parity: ``distinct_id`` REQUIRED + validated (a NEUTRAL throw BEFORE any
network, zero requests); ``evaluate`` resolving the snapshot with the correct wire body carrying
``distinct_id``; ``on_change`` firing EXACTLY once (the stateless-server degenerate cardinality);
a non-2xx round-trip (the urllib-HTTPError path) degrading to ``empty_flag_set()`` (``unresolved``,
NOT a crash); fetch-PER-CALL (two evaluates ⇒ two independent wire bodies, never shared); the
neutral degradation signal (``degraded``/``reason``) with NO vendor eval-quality field on the
snapshot; the config-selected factory (keyed ⇒ real adapter, unkeyed/endpointless ⇒ null object);
the provider ``flags`` slot populated when keyed + a flag endpoint, ``None`` otherwise; and that
``evaluate`` is SYNCHRONOUS by design (a bare ``FlagSet``, never a coroutine).
"""

from __future__ import annotations

import inspect
import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, cast

import pytest

from analytics_kit import (
    FeatureFlagPort,
    FlagClientConfig,
    FlagNoop,
    FlagSet,
    NeutralResponse,
    create_flag_client,
    create_server_analytics,
    empty_flag_set,
)
from analytics_kit.flags.adapter import HttpFlagAdapter


class _Send:
    """One recorded transport send."""

    def __init__(self, url: str, method: str, headers: dict[str, str], body: str | None) -> None:
        self.url = url
        self.method = method
        self.headers = headers
        self.body = body

    @property
    def wire_body(self) -> dict[str, Any]:
        assert self.body is not None
        return cast("dict[str, Any]", json.loads(self.body))


class _CannedTransport:
    """A mock transport that records every send and replays canned responses in order.

    ``responses`` is a queue of ``NeutralResponse`` consumed one per send; once exhausted the last
    repeats. Never touches a network.
    """

    def __init__(self, responses: list[NeutralResponse]) -> None:
        self._responses = responses
        self.sends: list[_Send] = []

    def send(
        self,
        url: str,
        method: str,
        headers: dict[str, str],
        body: str | None = None,
    ) -> NeutralResponse:
        self.sends.append(_Send(url, method, headers, body))
        if len(self.sends) <= len(self._responses):
            return self._responses[len(self.sends) - 1]
        return self._responses[-1]


class _RaisingTransport:
    """A mock transport whose ``send`` records the call but raises — a genuine network failure.

    Used to prove a raised transport error does NOT crash ``evaluate`` (it degrades). A real
    ``_UrllibFlagTransport`` catches ``HTTPError``/network errors and never raises, but a custom
    injected transport could; the adapter must be robust to a non-OK STATUS regardless, and this
    transport lets us assert the network-failure branch too.
    """

    def __init__(self) -> None:
        self.sends: list[_Send] = []


# --- a v2-shaped resolved response --------------------------------------------------------------


def _resolved_response() -> NeutralResponse:
    """A well-formed resolved wire response: a variant flag + a boolean flag + a JSON payload, plus
    vendor eval-quality metadata the adapter must NOT read onto the snapshot."""
    body = json.dumps(
        {
            "flags": {
                "checkout_variant": {
                    "enabled": True,
                    "variant": "a",
                    "metadata": {"payload": json.dumps({"discount": 10})},
                },
                "dark_mode": {"enabled": True, "variant": None},
                "legacy_off": {"enabled": False, "variant": None},
            },
            # Vendor eval-quality metadata — must stay adapter-internal, never on the snapshot.
            "errorsWhileComputingFlags": False,
            "quotaLimited": [],
            "requestId": "req-123",
        }
    )
    return NeutralResponse(status=200, body=body)


def _adapter(transport: _CannedTransport, **kwargs: Any) -> HttpFlagAdapter:
    return HttpFlagAdapter(
        key="test-key",
        flag_endpoint="https://flags.example",
        transport=cast("Any", transport),
        **kwargs,
    )


# --- sync-by-design -----------------------------------------------------------------------------


def test_evaluate_is_synchronous_not_a_coroutine_by_design() -> None:
    # The load-bearing parity call: the adapter's evaluate is a plain def returning a bare FlagSet,
    # never a coroutine. A future reader must NOT "fix" this toward asyncio — the blocking round-trip
    # is a blocking transport call, exactly as the HTTP query adapter hides its poll behind sleep.
    assert not inspect.iscoroutinefunction(HttpFlagAdapter.evaluate)
    assert not inspect.iscoroutinefunction(HttpFlagAdapter.on_change)


def test_adapter_satisfies_the_neutral_feature_flag_port() -> None:
    adapter: FeatureFlagPort = _adapter(_CannedTransport([_resolved_response()]))
    assert callable(adapter.evaluate)
    assert callable(adapter.on_change)


# --- distinct_id required + validated (pre-network throw) ----------------------------------------


def test_evaluate_without_distinct_id_raises_before_any_network() -> None:
    transport = _CannedTransport([_resolved_response()])
    adapter = _adapter(transport)
    with pytest.raises(ValueError) as exc:
        adapter.evaluate()
    # No network was touched — the throw is pre-network.
    assert transport.sends == []
    message = str(exc.value)
    assert "distinct_id" in message
    # Neutral message — no vendor token.
    assert "posthog" not in message.lower()


def test_evaluate_with_empty_distinct_id_raises_before_any_network() -> None:
    transport = _CannedTransport([_resolved_response()])
    adapter = _adapter(transport)
    with pytest.raises(ValueError):
        adapter.evaluate({"distinct_id": ""})
    assert transport.sends == []


# --- evaluate resolves the snapshot + carries distinct_id ----------------------------------------


def test_evaluate_resolves_the_snapshot_and_carries_distinct_id_on_the_wire() -> None:
    transport = _CannedTransport([_resolved_response()])
    adapter = _adapter(transport)

    snapshot = adapter.evaluate({"distinct_id": "user-1"})

    assert snapshot.degraded is False
    assert snapshot.is_enabled("checkout_variant") is True
    assert snapshot.get_flag("checkout_variant") == "a"
    assert snapshot.get_flag("dark_mode") is True
    assert snapshot.is_enabled("legacy_off") is False
    assert snapshot.get_flag("legacy_off") is False
    assert snapshot.get_payload("checkout_variant") == {"discount": 10}
    assert snapshot.reason("checkout_variant") == "resolved"

    # The wire body carried this call's distinct_id, in-body auth, and hit the flag path.
    assert len(transport.sends) == 1
    sent = transport.sends[0]
    assert sent.method == "POST"
    assert sent.url == "https://flags.example/flags/?v=2"
    body = sent.wire_body
    assert body["distinct_id"] == "user-1"
    assert body["api_key"] == "test-key"


def test_evaluate_threads_optional_context_onto_the_wire() -> None:
    transport = _CannedTransport([_resolved_response()])
    adapter = _adapter(transport)

    adapter.evaluate(
        {
            "distinct_id": "user-1",
            "groups": {"org": "acme"},
            "person_properties": {"plan": "pro"},
            "group_properties": {"org": {"tier": "gold"}},
            "flag_keys": ["checkout_variant"],
        }
    )

    body = transport.sends[0].wire_body
    assert body["groups"] == {"org": "acme"}
    assert body["person_properties"] == {"plan": "pro"}
    assert body["group_properties"] == {"org": {"tier": "gold"}}
    assert body["flag_keys_to_evaluate"] == ["checkout_variant"]


def test_missing_flag_reads_distinguish_missing_from_disabled() -> None:
    transport = _CannedTransport([_resolved_response()])
    adapter = _adapter(transport)
    snapshot = adapter.evaluate({"distinct_id": "user-1"})

    # A flag absent from the response: get_flag None, is_enabled False, reason None.
    assert snapshot.get_flag("never_declared") is None
    assert snapshot.is_enabled("never_declared") is False
    assert snapshot.reason("never_declared") is None
    # get_all carries only resolved flags.
    assert set(snapshot.get_all()) == {"checkout_variant", "dark_mode", "legacy_off"}


# --- on_change fires exactly once ----------------------------------------------------------------


def test_on_change_fires_once_when_registered_before_evaluate() -> None:
    transport = _CannedTransport([_resolved_response()])
    adapter = _adapter(transport)

    received: list[FlagSet] = []
    unsubscribe = adapter.on_change(received.append)

    adapter.evaluate({"distinct_id": "user-1"})
    adapter.evaluate({"distinct_id": "user-2"})  # second evaluate does NOT re-fire

    assert len(received) == 1
    assert received[0].get_flag("checkout_variant") == "a"
    # Unsubscribe after the fire is a sound no-op.
    unsubscribe()


def test_on_change_registered_after_fire_receives_the_resolved_set_once() -> None:
    transport = _CannedTransport([_resolved_response()])
    adapter = _adapter(transport)

    adapter.evaluate({"distinct_id": "user-1"})

    received: list[FlagSet] = []
    unsubscribe = adapter.on_change(received.append)
    # Late listener sees the resolved set immediately, exactly once.
    assert len(received) == 1
    adapter.evaluate({"distinct_id": "user-2"})
    assert len(received) == 1
    unsubscribe()


def test_unsubscribe_before_fire_prevents_the_fire() -> None:
    transport = _CannedTransport([_resolved_response()])
    adapter = _adapter(transport)

    received: list[FlagSet] = []
    unsubscribe = adapter.on_change(received.append)
    unsubscribe()

    adapter.evaluate({"distinct_id": "user-1"})
    assert received == []


# --- fetch-per-call (never shares a wire body across differing contexts) -------------------------


def test_two_evaluates_send_two_independent_wire_bodies() -> None:
    transport = _CannedTransport([_resolved_response()])
    adapter = _adapter(transport)

    adapter.evaluate({"distinct_id": "user-1"})
    adapter.evaluate({"distinct_id": "user-2", "person_properties": {"plan": "pro"}})

    assert len(transport.sends) == 2
    first = transport.sends[0].wire_body
    second = transport.sends[1].wire_body
    assert first["distinct_id"] == "user-1"
    assert second["distinct_id"] == "user-2"
    assert "person_properties" not in first
    assert second["person_properties"] == {"plan": "pro"}


# --- degradation: a failed round-trip → empty_flag_set (unresolved), never a crash ---------------


def test_non_2xx_round_trip_degrades_to_empty_flag_set() -> None:
    # The urllib-HTTPError lesson: a non-2xx status returns (via the transport) as a NeutralResponse
    # with the real status, and the adapter degrades — it does NOT crash evaluate.
    transport = _CannedTransport([NeutralResponse(status=500, body="server error")])
    adapter = _adapter(transport)

    snapshot = adapter.evaluate({"distinct_id": "user-1"})

    # The degraded-empty result is the canonical empty_flag_set() null-object (never a hand-rolled
    # second empty): 'unresolved' for EVERY key, degraded True — the neutral degradation signal.
    assert snapshot is empty_flag_set()
    assert snapshot.degraded is True
    assert snapshot.reason("anything") == "unresolved"
    assert snapshot.get_all() == {}
    assert snapshot.is_enabled("checkout_variant") is False


# --- the REAL urllib transport over a loopback socket: a non-2xx surfaces its status, no crash ----


class _StatusServer:
    """A localhost server replying with a fixed status — drives the REAL ``_UrllibFlagTransport``.

    ``urllib.request.urlopen`` RAISES ``HTTPError`` on every non-2xx, so nothing but a real socket
    exercises the transport's actual ``HTTPError`` catch (the canned mock transports return a status
    and never hit the catch). Mirrors the PY8 loopback probe style.
    """

    def __init__(self, *, status: int) -> None:
        self.requests = 0
        recorder = self

        class _Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler naming.
                length = int(self.headers.get("Content-Length", "0"))
                self.rfile.read(length)
                recorder.requests += 1
                self.send_response(status)
                self.end_headers()
                self.wfile.write(b"server error")

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
def status_500_server() -> Iterator[_StatusServer]:
    server = _StatusServer(status=500)
    try:
        yield server
    finally:
        server.close()


def test_real_urllib_transport_surfaces_a_non_2xx_status_without_raising(
    status_500_server: _StatusServer,
) -> None:
    # The default transport (not a mock) drives the actual HTTPError catch: urlopen RAISES on the
    # 500, the transport catches it and returns the real status — no crash, no raw HTTPError escape.
    from analytics_kit.flags.transport import _UrllibFlagTransport

    response = _UrllibFlagTransport().send(
        f"{status_500_server.host}/flags/?v=2",
        "POST",
        {"Content-Type": "application/json"},
        "{}",
    )
    assert response.status == 500
    assert status_500_server.requests == 1


def test_real_urllib_transport_non_2xx_degrades_evaluate_to_empty_flag_set(
    status_500_server: _StatusServer,
) -> None:
    # End-to-end over a real socket: the adapter wired to the DEFAULT transport degrades a 500 to
    # the canonical empty_flag_set() null-object (unresolved) rather than crashing evaluate with an
    # escaped HTTPError.
    adapter = HttpFlagAdapter(key="k", flag_endpoint=status_500_server.host)

    snapshot = adapter.evaluate({"distinct_id": "user-1"})

    assert snapshot is empty_flag_set()
    assert snapshot.degraded is True
    assert snapshot.reason("anything") == "unresolved"
    assert snapshot.get_all() == {}
    assert status_500_server.requests == 1


def test_malformed_body_degrades_to_empty_flag_set() -> None:
    transport = _CannedTransport([NeutralResponse(status=200, body="not json")])
    adapter = _adapter(transport)

    snapshot = adapter.evaluate({"distinct_id": "user-1"})
    assert snapshot is empty_flag_set()
    assert snapshot.degraded is True
    assert snapshot.reason("anything") == "unresolved"


# --- a bounded request timeout: an unresponsive endpoint degrades, never hangs (U2) --------------


def test_urllib_flag_transport_passes_a_bounded_timeout_to_urlopen() -> None:
    # Every flag-eval request carries a bounded wall-clock cap, so an unresponsive endpoint can't
    # hang the caller. Assert the transport actually threads a positive `timeout` into `urlopen`
    # (a mutation dropping the timeout arg makes this fail).
    import urllib.request

    from analytics_kit.flags.transport import _UrllibFlagTransport

    seen: dict[str, object] = {}
    real_urlopen = urllib.request.urlopen

    def _spy(request: object, *args: object, timeout: object = None, **kwargs: object) -> object:
        seen["timeout"] = timeout
        raise TimeoutError("timed out")

    urllib.request.urlopen = cast("Any", _spy)
    try:
        # The send normalizes the raised TimeoutError to a degraded response; we only care that a
        # positive `timeout` reached urlopen.
        _UrllibFlagTransport().send(
            "https://flags.example/flags/?v=2", "POST", {"Content-Type": "application/json"}, "{}"
        )
    finally:
        urllib.request.urlopen = real_urlopen

    assert isinstance(seen["timeout"], (int, float)) and seen["timeout"] > 0


def test_urllib_flag_transport_normalizes_a_timeout_to_status_0_without_raising() -> None:
    # A `TimeoutError` out of `urlopen` (the bounded-timeout expiry) must degrade exactly like a
    # network failure — status 0, no raised exception crossing the seam.
    import urllib.request

    from analytics_kit.flags.transport import _UrllibFlagTransport

    real_urlopen = urllib.request.urlopen

    def _timeout(*_args: object, **_kwargs: object) -> object:
        raise TimeoutError("timed out")

    urllib.request.urlopen = cast("Any", _timeout)
    try:
        response = _UrllibFlagTransport().send(
            "https://flags.example/flags/?v=2", "POST", {"Content-Type": "application/json"}, "{}"
        )
    finally:
        urllib.request.urlopen = real_urlopen

    assert response.status == 0
    assert response.body == ""


def test_a_timeout_out_of_the_transport_degrades_evaluate_to_empty_flag_set() -> None:
    # End-to-end: a transport whose send times out (status 0) degrades `evaluate` to the canonical
    # empty_flag_set() null-object rather than crashing — the same degrade path a non-2xx / network
    # failure takes.
    transport = _CannedTransport([NeutralResponse(status=0, body="")])
    adapter = _adapter(transport)

    snapshot = adapter.evaluate({"distinct_id": "user-1"})
    assert snapshot is empty_flag_set()
    assert snapshot.degraded is True
    assert snapshot.reason("anything") == "unresolved"
    assert snapshot.get_all() == {}


def test_a_raising_transport_degrades_rather_than_crashing_evaluate() -> None:
    class _Boom:
        def send(self, url: str, method: str, headers: dict[str, str], body: str | None = None) -> NeutralResponse:
            raise RuntimeError("network down")

    adapter = HttpFlagAdapter(
        key="k",
        flag_endpoint="https://flags.example",
        transport=cast("Any", _Boom()),
    )
    # A raised transport error is normalized to degradation — flags degrade, they never raise to
    # the consumer. The evaluate returns the canonical empty_flag_set(), not a propagated RuntimeError.
    snapshot = adapter.evaluate({"distinct_id": "user-1"})
    assert snapshot is empty_flag_set()
    assert snapshot.degraded is True
    assert snapshot.reason("anything") == "unresolved"
    assert snapshot.get_all() == {}


def test_failed_round_trip_falls_back_to_bootstrap_seed_as_stale() -> None:
    from analytics_kit import FlagBootstrap

    transport = _CannedTransport([NeutralResponse(status=503, body="down")])
    adapter = _adapter(
        transport,
        bootstrap=FlagBootstrap(flags={"dark_mode": True}, payloads={"dark_mode": {"theme": "x"}}),
    )

    snapshot = adapter.evaluate({"distinct_id": "user-1"})
    # A configured bootstrap is served (as a degraded, stale fallback) rather than the empty set.
    assert snapshot.get_flag("dark_mode") is True
    assert snapshot.get_payload("dark_mode") == {"theme": "x"}
    assert snapshot.degraded is True
    assert snapshot.reason("dark_mode") == "stale"


def test_stale_fallback_preserves_a_payload_only_bootstrap_key() -> None:
    from analytics_kit import FlagBootstrap

    transport = _CannedTransport([NeutralResponse(status=503, body="down")])
    # `orphan` has a bootstrap payload but NO matching flag value — it must survive the stale path
    # (the get_all()-reconstruction bug dropped payload-only keys).
    adapter = _adapter(
        transport,
        bootstrap=FlagBootstrap(
            flags={"dark_mode": True},
            payloads={"dark_mode": {"theme": "x"}, "orphan": {"note": "payload-only"}},
        ),
    )

    snapshot = adapter.evaluate({"distinct_id": "user-1"})
    assert snapshot.get_payload("orphan") == {"note": "payload-only"}
    assert snapshot.reason("orphan") == "stale"
    # The orphan has no flag value, so it stays absent from the flag map / is_enabled reads.
    assert snapshot.get_flag("orphan") is None
    assert snapshot.is_enabled("orphan") is False


# --- no vendor eval-quality field leaks onto the snapshot ----------------------------------------


def test_vendor_eval_quality_metadata_is_not_read_onto_the_snapshot() -> None:
    transport = _CannedTransport([_resolved_response()])
    adapter = _adapter(transport)
    snapshot = adapter.evaluate({"distinct_id": "user-1"})

    # The FlagSet exposes only the neutral read surface + degradation signal — no requestId,
    # errorsWhileComputing, quotaLimited surface anywhere.
    assert not hasattr(snapshot, "requestId")
    assert not hasattr(snapshot, "errorsWhileComputingFlags")
    assert not hasattr(snapshot, "quotaLimited")
    # get_all carries only the neutral key→value map, no eval-quality keys.
    assert "requestId" not in snapshot.get_all()
    assert "errorsWhileComputingFlags" not in snapshot.get_all()


# --- the config-selected factory (bar B) ---------------------------------------------------------


def test_factory_keyed_and_endpointed_returns_the_real_adapter() -> None:
    client = create_flag_client(FlagClientConfig(key="k", flag_endpoint="https://flags.example"))
    assert isinstance(client, HttpFlagAdapter)


def test_factory_unkeyed_returns_the_null_object() -> None:
    client = create_flag_client(FlagClientConfig(flag_endpoint="https://flags.example"))
    assert isinstance(client, FlagNoop)


def test_factory_keyed_but_endpointless_returns_the_null_object() -> None:
    client = create_flag_client(FlagClientConfig(key="k"))
    assert isinstance(client, FlagNoop)


def test_flag_noop_resolves_the_empty_snapshot_and_fires_once() -> None:
    noop = FlagNoop()
    received: list[FlagSet] = []
    noop.on_change(received.append)
    assert len(received) == 1

    snapshot = noop.evaluate({"distinct_id": "user-1"})
    assert snapshot is empty_flag_set()
    assert snapshot.degraded is True
    assert snapshot.get_all() == {}


# --- the provider flags slot (the story's locked attach) -----------------------------------------


# These assert ONLY on the provider's `.flags` slot, so they run the server stack in `sync_mode`
# (inline delivery, no background daemon): a keyed `create_server_analytics` otherwise starts a
# BatchConsumer daemon thread that, unjoined, would leak past the test (the reliability suite's
# leaked-thread assertion catches exactly that). The flags slot is independent of the capture
# delivery mode, so `sync_mode=True` is a faithful, thread-free way to exercise the attach.
def test_server_provider_flags_slot_populated_when_keyed_with_a_flag_endpoint() -> None:
    analytics = create_server_analytics(
        {
            "key": "k",
            "ingest_host": "https://ingest.example",
            "sync_mode": True,
            "flags": {"flag_endpoint": "https://flags.example"},
        }
    )
    assert analytics.flags is not None
    assert isinstance(analytics.flags, HttpFlagAdapter)


def test_server_provider_flags_slot_is_none_without_a_flag_endpoint() -> None:
    analytics = create_server_analytics(
        {"key": "k", "ingest_host": "https://ingest.example", "sync_mode": True}
    )
    assert analytics.flags is None


def test_server_provider_flags_slot_is_none_when_unkeyed() -> None:
    # Unkeyed ⇒ whole-stack no-op; the flags slot stays None (the bar-B no-op precedent).
    analytics = create_server_analytics({"flags": {"flag_endpoint": "https://flags.example"}})
    assert analytics.flags is None
