"""E20-S2 — static-definitions config seeding (Python server).

A consumer supplies STATIC flag definitions (the neutral S1 shape) via config; the local-eval
snapshot is SEEDED directly (via S1's ``lower_definitions``), bypassing the poller fetch. This suite
proves the zero-egress invariant (no ``/flags/`` calls, no definition fetch, no URL) against a
recording/injectable transport, the equal-value-vs-poller invariant (a static-seeded client resolves
to the SAME values the poller path resolves for equivalent WIRE definitions), and that a malformed
static set raises LOUDLY at client construction. Mirrors the ``test_flag_parity.py`` posture.
"""

from __future__ import annotations

import json
import threading
import warnings
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, cast

import pytest
from pydantic import ValidationError

from analytics_kit import FeatureFlagDefinition, FlagClientConfig, FlagContext, create_flag_client
from analytics_kit.flags.adapter import HttpFlagAdapter, LocalEvalCapability
from analytics_kit.flags.local.definition_poller import DefinitionPoller
from analytics_kit.flags.noop import FlagNoop
from analytics_kit.flags.transport import FlagTransport

# ---------------------------------------------------------------------------------------------
# The neutral static definitions the consumer authors (S1 FeatureFlagDefinition). Their WIRE
# equivalents drive the poller path in the equal-value proof below.
# ---------------------------------------------------------------------------------------------

# A 100%-rollout boolean flag → True for every actor; payload keyed by the resolved value.
SIMPLE_STATIC: FeatureFlagDefinition = {
    "key": "simple-flag",
    "enabled": True,
    "conditions": [{"property_filters": [], "rollout_percentage": 100}],
    "payloads": {"true": json.dumps({"via": "defn"})},
}

# The pinned multivariate flag (group 55%, variants 50/20/20/5/5) → distinct_id_0 → second-variant.
MULTIVARIATE_STATIC: FeatureFlagDefinition = {
    "key": "multivariate-flag",
    "enabled": True,
    "conditions": [{"property_filters": [], "rollout_percentage": 55}],
    "variants": [
        {"key": "first-variant", "rollout_percentage": 50},
        {"key": "second-variant", "rollout_percentage": 20},
        {"key": "third-variant", "rollout_percentage": 20},
        {"key": "fourth-variant", "rollout_percentage": 5},
        {"key": "fifth-variant", "rollout_percentage": 5},
    ],
    "payloads": {"second-variant": json.dumps({"tier": "silver"})},
}

# A property-gated flag (plan=pro at 100%) → True when the person property is supplied.
PROP_STATIC: FeatureFlagDefinition = {
    "key": "prop-flag",
    "enabled": True,
    "conditions": [{"property_filters": [{"property": "plan", "value": "pro"}], "rollout_percentage": 100}],
}


def _static_definitions() -> list[FeatureFlagDefinition]:
    return [dict(SIMPLE_STATIC), dict(MULTIVARIATE_STATIC), dict(PROP_STATIC)]  # type: ignore[list-item]


# The WIRE equivalents — what a poller would fetch and seed. Kept in lockstep with the neutral set;
# the equal-value proof runs BOTH and asserts identical resolution.
def _simple_wire() -> dict[str, Any]:
    return {
        "key": "simple-flag",
        "active": True,
        "filters": {
            "groups": [{"properties": [], "rollout_percentage": 100}],
            "payloads": {"true": json.dumps({"via": "defn"})},
        },
    }


def _multivariate_wire() -> dict[str, Any]:
    return {
        "key": "multivariate-flag",
        "active": True,
        "filters": {
            "groups": [{"properties": [], "rollout_percentage": 55}],
            "multivariate": {
                "variants": [
                    {"key": "first-variant", "rollout_percentage": 50},
                    {"key": "second-variant", "rollout_percentage": 20},
                    {"key": "third-variant", "rollout_percentage": 20},
                    {"key": "fourth-variant", "rollout_percentage": 5},
                    {"key": "fifth-variant", "rollout_percentage": 5},
                ]
            },
            "payloads": {"second-variant": json.dumps({"tier": "silver"})},
        },
    }


def _prop_wire() -> dict[str, Any]:
    return {
        "key": "prop-flag",
        "active": True,
        "filters": {"groups": [{"properties": [{"key": "plan", "value": "pro"}], "rollout_percentage": 100}]},
    }


def _wire_definitions() -> list[dict[str, Any]]:
    return [_simple_wire(), _multivariate_wire(), _prop_wire()]


CONTEXT: FlagContext = {"distinct_id": "distinct_id_0", "person_properties": {"plan": "pro"}}


class _RecordingTransport:
    """A transport that FAILS the test if it is ever called — the zero-egress guard. A static-seeded
    local-only client must resolve entirely in-process: no definition fetch, no remote round-trip."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def send(self, url: str, method: str, headers: dict[str, str], body: str | None = None) -> Any:
        self.calls.append((method, url))
        raise AssertionError(f"transport was hit ({method} {url}) — a static-seeded client must not egress")


# ---------------------------------------------------------------------------------------------
# Zero-egress: a static-defs + local-only client makes NO network calls of any kind.
# ---------------------------------------------------------------------------------------------


def test_zero_egress_transport_is_never_called() -> None:
    transport = _RecordingTransport()
    client = create_flag_client(
        FlagClientConfig(
            key="k",
            static_definitions=_static_definitions(),
            only_evaluate_locally=True,
            transport=cast("FlagTransport", transport),
        )
    )
    try:
        result = client.evaluate(CONTEXT)

        # Resolved from the seeded snapshot…
        assert result.get_flag("simple-flag") is True
        assert result.get_flag("multivariate-flag") == "second-variant"
        assert result.get_flag("prop-flag") is True
        assert result.degraded is False
        # …and the transport was never hit: zero definition fetches, zero /flags/ calls.
        assert transport.calls == []
    finally:
        cast("HttpFlagAdapter", client).stop()


def test_canonical_self_host_shape_selects_the_real_adapter() -> None:
    # NO definitions_endpoint / definitions_key / flag_endpoint — the documented zero-/flags/ shape.
    client = create_flag_client(
        FlagClientConfig(
            key="k",
            static_definitions=_static_definitions(),
            only_evaluate_locally=True,
        )
    )
    try:
        # A static-defs config is a real route, so the keyed-but-no-route guard does NOT no-op it.
        assert isinstance(client, HttpFlagAdapter)
        assert not isinstance(client, FlagNoop)
    finally:
        cast("HttpFlagAdapter", client).stop()


def test_stop_on_a_static_defs_client_is_a_clean_idempotent_no_op() -> None:
    client = create_flag_client(
        FlagClientConfig(key="k", static_definitions=_static_definitions(), only_evaluate_locally=True)
    )
    adapter = cast("HttpFlagAdapter", client)
    # No thread was ever started, so stop() joins nothing and is safe to call repeatedly.
    adapter.stop()
    adapter.stop()


def test_unkeyed_static_defs_config_is_a_silent_no_op() -> None:
    # key is still required (the factory's no-op gate). An unkeyed static-defs config is the no-op.
    client = create_flag_client(FlagClientConfig(static_definitions=_static_definitions()))
    assert isinstance(client, FlagNoop)


# ---------------------------------------------------------------------------------------------
# Equal value vs the poller path: a static-seeded client resolves to the SAME values a poller-fed
# client resolves for the equivalent wire definitions — the UNCHANGED evaluator reads the seed
# snapshot identically. The poller side crosses a real socket (mirroring test_flag_parity.py).
# ---------------------------------------------------------------------------------------------


class _DefsLoopbackServer:
    """A real localhost server serving canned definitions (GET) + a canned remote answer (POST)."""

    def __init__(self, definitions: list[dict[str, Any]]) -> None:
        self.posts: list[dict[str, Any]] = []
        defs_payload = json.dumps({"flags": definitions, "group_type_mapping": {}, "cohorts": {}}).encode("utf-8")
        remote_payload = json.dumps({"flags": {}}).encode("utf-8")
        recorder = self

        class _Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                if self.path.startswith("/flags/definitions"):
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(defs_payload)
                    return
                self.send_response(404)
                self.end_headers()

            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length)
                recorder.posts.append(json.loads(raw.decode("utf-8")) if raw else {})
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(remote_payload)

            def log_message(self, *_args: Any) -> None:
                pass

        self._server = HTTPServer(("127.0.0.1", 0), _Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def origin(self) -> str:
        address, port = self._server.server_address[:2]
        host = address.decode() if isinstance(address, bytes) else address
        return f"http://{host}:{port}"

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)


@pytest.fixture
def loopback() -> Iterator[Any]:
    servers: list[_DefsLoopbackServer] = []

    def make(definitions: list[dict[str, Any]]) -> _DefsLoopbackServer:
        server = _DefsLoopbackServer(definitions)
        servers.append(server)
        return server

    try:
        yield make
    finally:
        for server in servers:
            server.close()


def test_equal_value_vs_the_poller_path(loopback: Any) -> None:
    server = loopback(_wire_definitions())

    # The poller side: a real DefinitionPoller fetching the WIRE definitions over a real socket.
    poller = DefinitionPoller(
        definitions_endpoint=server.origin,
        definitions_key="privileged-key",
        token="project-token",
        poll_interval=60.0,
    )
    poller_adapter = HttpFlagAdapter(
        key="project-token",
        flag_endpoint=server.origin,
        local=LocalEvalCapability(poller, only_locally=False),
    )
    assert poller.wait_for_first_load(timeout=5)
    assert poller.is_ready()

    # The static side: seeded from the NEUTRAL definitions via config alone.
    static_client = create_flag_client(
        FlagClientConfig(
            key="project-token",
            static_definitions=_static_definitions(),
            only_evaluate_locally=True,
        )
    )

    try:
        poller_set = poller_adapter.evaluate(CONTEXT)
        static_set = static_client.evaluate(CONTEXT)

        for key in ("simple-flag", "multivariate-flag", "prop-flag"):
            assert static_set.get_flag(key) == poller_set.get_flag(key)
            assert static_set.get_payload(key) == poller_set.get_payload(key)
            assert static_set.is_enabled(key) == poller_set.is_enabled(key)
        # And they match the reference-correct ground truth, not just each other.
        assert static_set.get_flag("multivariate-flag") == "second-variant"
        assert static_set.get_payload("multivariate-flag") == {"tier": "silver"}
        # The poller path posted ZERO remote /flags calls (all decided locally) — same as static.
        assert len(server.posts) == 0
    finally:
        poller_adapter.stop()
        cast("HttpFlagAdapter", static_client).stop()


def test_flipped_rollout_boundary_flips_the_static_answer() -> None:
    # simple-flag at 0% admits no one → False, the OPPOSITE of the 100% seed. Proves the seed feeds
    # the real evaluator (a vacuous seed would not tell these apart).
    zero_rollout: FeatureFlagDefinition = {
        "key": "simple-flag",
        "enabled": True,
        "conditions": [{"property_filters": [], "rollout_percentage": 0}],
    }
    client = create_flag_client(
        FlagClientConfig(key="k", static_definitions=[zero_rollout], only_evaluate_locally=True)
    )
    try:
        result = client.evaluate(CONTEXT)
        assert result.get_flag("simple-flag") is False
    finally:
        cast("HttpFlagAdapter", client).stop()


# ---------------------------------------------------------------------------------------------
# Malformed static definitions raise LOUDLY at construction — the seed-time input boundary.
# ---------------------------------------------------------------------------------------------


def test_duplicate_key_raises_at_construction_without_touching_the_transport() -> None:
    transport = _RecordingTransport()
    with pytest.raises(ValidationError):
        create_flag_client(
            FlagClientConfig(
                key="k",
                static_definitions=[{"key": "dup", "enabled": True}, {"key": "dup", "enabled": False}],
                only_evaluate_locally=True,
                transport=cast("FlagTransport", transport),
            )
        )
    # No adapter constructed ⇒ no side effect: the transport was never touched.
    assert transport.calls == []


def test_out_of_range_rollout_raises_at_construction() -> None:
    with pytest.raises(ValidationError):
        create_flag_client(
            FlagClientConfig(
                key="k",
                static_definitions=[{"key": "f", "enabled": True, "conditions": [{"rollout_percentage": 150}]}],
                only_evaluate_locally=True,
            )
        )


def test_empty_static_definitions_is_a_real_route_not_a_throw_and_dev_warns() -> None:
    # A present-but-empty list is a valid seed: it lowers to an empty snapshot. is_ready() is False
    # (no flags), so a local-only client degrades to the neutral unresolved set — no throw, no fetch.
    # An empty set degrades every eval silently, so construction dev-warns to make it observable.
    transport = _RecordingTransport()
    with pytest.warns(UserWarning, match="static_definitions is empty"):
        client = create_flag_client(
            FlagClientConfig(
                key="k",
                static_definitions=[],
                only_evaluate_locally=True,
                transport=cast("FlagTransport", transport),
            )
        )
    try:
        result = client.evaluate(CONTEXT)
        assert result.get_all() == {}
        assert result.degraded is True
        assert transport.calls == []
    finally:
        cast("HttpFlagAdapter", client).stop()


def test_non_empty_static_definitions_does_not_warn() -> None:
    # The empty-set dev-warn must NOT fire for a real (non-empty) static config.
    with warnings.catch_warnings():
        warnings.simplefilter("error")  # any warning would raise and fail the test
        client = create_flag_client(
            FlagClientConfig(
                key="k",
                static_definitions=_static_definitions(),
                only_evaluate_locally=True,
            )
        )
    cast("HttpFlagAdapter", client).stop()
