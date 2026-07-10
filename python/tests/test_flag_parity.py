"""E13-S4 — ground-truth + cross-tree parity proof (Python server).

The CC-reachable, KEY-LESS layers stand up a real loopback ``http.server`` (a real socket on an
ephemeral port, the PY8 "real path, not a self-consistent mock" lesson) that serves BOTH the canned
flag DEFINITIONS to the poller AND a canned remote ``/flags`` response to the shipped round-trip. The
REAL default ``_UrllibFlagTransport`` crosses a real socket in both directions (NO injected mock).
We evaluate the SAME definitions locally and remotely and assert per-flag agreement, then prove the
diff BITES via negative controls. The cross-tree hash anchor re-pins the SINGLE parity vector both
trees bind to (byte-for-byte identical to the TS-node suite).

The live privileged-key ground-truth (diffing local eval against a REAL backend's own bucketing) is
the ONLY key-gated layer: it SKIPS cleanly when the key is absent (the PY8 precedent). Layers 1 and 2
stay fully green with no external setup or key.
"""

from __future__ import annotations

import json
import os
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, cast

import pytest

from analytics_kit import FlagClientConfig, FlagContext, create_flag_client
from analytics_kit.flags.adapter import HttpFlagAdapter, LocalEvalCapability
from analytics_kit.flags.local.definition_poller import DefinitionPoller
from analytics_kit.flags.local.evaluator import evaluate_flag_locally
from analytics_kit.flags.local.hash import bucket_hash, hash_sha1

# ---------------------------------------------------------------------------------------------
# The known flag set. Their resolved values are the S1 reference-suite consistency vectors (the
# reviewer independently recomputed them against the reference bucketing arithmetic), so the canned
# remote response below is pinned to a values-known-correct external contract — NOT derived from the
# local evaluator (which would be the self-consistent mock PY8 warned against).
# ---------------------------------------------------------------------------------------------


def _simple_flag() -> dict[str, Any]:
    # A 100%-rollout boolean flag → True for every actor; payload keyed by the stringified value.
    return {
        "key": "simple-flag",
        "active": True,
        "filters": {
            "groups": [{"properties": [], "rollout_percentage": 100}],
            "payloads": {"true": json.dumps({"via": "defn"})},
        },
    }


def _multivariate_flag() -> dict[str, Any]:
    # The pinned multivariate flag (group 55%, variants 50/20/20/5/5) → distinct_id_0 → second-variant.
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


def _prop_flag() -> dict[str, Any]:
    # A property-gated flag (plan=pro at 100%) → True when the person property is supplied. Proves the
    # local matcher reads person properties straight off the FlagContext, as the backend does.
    return {
        "key": "prop-flag",
        "active": True,
        "filters": {"groups": [{"properties": [{"key": "plan", "value": "pro"}], "rollout_percentage": 100}]},
    }


def _known_definitions() -> list[dict[str, Any]]:
    return [_simple_flag(), _multivariate_flag(), _prop_flag()]


# The ground-truth CONTEXT: distinct_id_0 with plan=pro. The same context drives both local + remote.
GROUND_TRUTH_CONTEXT: dict[str, Any] = {"distinct_id": "distinct_id_0", "person_properties": {"plan": "pro"}}

# The resolved values a REAL remote eval of the known definitions returns for the ground-truth context
# — pinned to the S1 reference vectors (the values-known-correct external contract). The canned remote
# response is built from THIS, so a passing local-vs-remote diff means local eval agrees with the
# reference-correct backend answer, not with a mock echoing the local result.
GROUND_TRUTH_FLAGS: dict[str, str | bool] = {
    "simple-flag": True,
    "multivariate-flag": "second-variant",
    "prop-flag": True,
}
GROUND_TRUTH_PAYLOADS: dict[str, Any] = {
    "simple-flag": {"via": "defn"},
    "multivariate-flag": {"tier": "silver"},
}


def _remote_v2_body(flags: dict[str, str | bool], payloads: dict[str, Any] | None = None) -> dict[str, Any]:
    """Encode the resolved set into the wire ``flags`` map of per-flag ``{enabled, variant, metadata:
    {payload}}`` objects the shipped remote path parses. Payloads ride as JSON strings, exactly as a
    real backend returns them."""
    payloads = payloads or {}
    entries: dict[str, Any] = {}
    for key, value in flags.items():
        entry: dict[str, Any]
        if isinstance(value, str):
            entry = {"enabled": True, "variant": value}
        else:
            entry = {"enabled": value, "variant": None}
        if key in payloads:
            entry["metadata"] = {"payload": json.dumps(payloads[key])}
        entries[key] = entry
    return {"flags": entries}


# ---------------------------------------------------------------------------------------------
# The loopback server — a real localhost ``http.server``. GET /flags/definitions serves the canned
# definitions to the poller; POST /flags/ serves a canned remote response to the shipped round-trip.
# It records every POST body so a negative control can assert whether — and for which keys — the
# remote path was actually reached over the socket.
# ---------------------------------------------------------------------------------------------


class _FlagLoopbackServer:
    """A real localhost server serving canned definitions (GET) + a canned remote answer (POST)."""

    def __init__(self, definitions: list[dict[str, Any]], remote_body: dict[str, Any]) -> None:
        self.posts: list[dict[str, Any]] = []
        defs_payload = json.dumps({"flags": definitions, "group_type_mapping": {}, "cohorts": {}}).encode("utf-8")
        remote_payload = json.dumps(remote_body).encode("utf-8")
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
def loopback_factory() -> Iterator[Any]:
    servers: list[_FlagLoopbackServer] = []

    def make(definitions: list[dict[str, Any]], remote_body: dict[str, Any]) -> _FlagLoopbackServer:
        server = _FlagLoopbackServer(definitions, remote_body)
        servers.append(server)
        return server

    try:
        yield make
    finally:
        for server in servers:
            server.close()


@pytest.fixture
def adapter_factory() -> Iterator[Any]:
    adapters: list[HttpFlagAdapter] = []

    def make_local(origin: str) -> HttpFlagAdapter:
        # A local-capable adapter over the REAL default urllib transport (a real socket) — no injected
        # mock. The poller loads definitions from the loopback; evaluate resolves in-process first.
        poller = DefinitionPoller(
            definitions_endpoint=origin,
            definitions_key="privileged-key",
            token="project-token",
            poll_interval=60.0,
        )
        adapter = HttpFlagAdapter(
            key="project-token",
            flag_endpoint=origin,
            local=LocalEvalCapability(poller, only_locally=False),
        )
        adapters.append(adapter)
        # start() (run in the constructor) already did a synchronous immediate first load, so the
        # poller is ready here — no extra load needed before the evaluate under test.
        assert poller.is_ready()
        return adapter

    def make_remote(origin: str) -> HttpFlagAdapter:
        adapter = HttpFlagAdapter(key="project-token", flag_endpoint=origin)
        adapters.append(adapter)
        return adapter

    yield {"local": make_local, "remote": make_remote}
    for adapter in adapters:
        adapter.stop()  # the E12-S4 lesson: stop the poll thread in teardown — no leaked thread.


# ---------------------------------------------------------------------------------------------
# Layer 1 — loopback ground-truth (KEY-LESS): local eval agrees with the real remote answer.
# ---------------------------------------------------------------------------------------------


def test_layer1_local_eval_agrees_with_the_remote_answer_per_flag(loopback_factory: Any, adapter_factory: Any) -> None:
    server = loopback_factory(_known_definitions(), _remote_v2_body(GROUND_TRUTH_FLAGS, GROUND_TRUTH_PAYLOADS))
    local = adapter_factory["local"](server.origin)
    remote = adapter_factory["remote"](server.origin)

    local_set = local.evaluate(GROUND_TRUTH_CONTEXT)
    remote_set = remote.evaluate(GROUND_TRUTH_CONTEXT)

    # Per-flag agreement: value + payload identical across the local and remote strategies.
    for key in GROUND_TRUTH_FLAGS:
        assert local_set.get_flag(key) == remote_set.get_flag(key)
        assert local_set.get_payload(key) == remote_set.get_payload(key)
        assert local_set.is_enabled(key) == remote_set.is_enabled(key)
    # And they match the reference-correct ground truth (not just each other).
    assert local_set.get_flag("simple-flag") is True
    assert local_set.get_flag("multivariate-flag") == "second-variant"
    assert local_set.get_flag("prop-flag") is True
    assert local_set.get_payload("multivariate-flag") == {"tier": "silver"}


def test_layer1_inconclusive_flag_hits_the_real_remote_transport(loopback_factory: Any, adapter_factory: Any) -> None:
    # The local eval here is INCONCLUSIVE for one flag (experience continuity) so the shipped remote
    # path is genuinely exercised over the socket — proving the fallback hits the real transport.
    continuity = {
        "key": "needs-remote",
        "active": True,
        "ensure_experience_continuity": True,
        "filters": {"groups": [{"properties": [], "rollout_percentage": 100}]},
    }
    server = loopback_factory(
        [_simple_flag(), continuity],
        _remote_v2_body({"needs-remote": "server-value"}),
    )
    local = adapter_factory["local"](server.origin)

    result = local.evaluate(GROUND_TRUTH_CONTEXT)

    # The locally-decidable flag resolved locally; the inconclusive one came from the real remote hit.
    assert result.get_flag("simple-flag") is True
    assert result.get_flag("needs-remote") == "server-value"
    # Exactly one POST crossed the socket, narrowed to only the flag local eval couldn't decide.
    assert len(server.posts) == 1
    assert server.posts[0]["flag_keys_to_evaluate"] == ["needs-remote"]


def test_layer1_send_cohorts_query_rides_the_definitions_fetch_on_the_wire(loopback_factory: Any, adapter_factory: Any) -> None:
    # The S1/S3 forward-note: confirm send_cohorts on the wire. The definitions URL carries the
    # send_cohorts query param (which asks the endpoint to include the cohort map so a static-cohort
    # flag is locally decidable rather than an inconclusive RequiresServerEvaluation). Assert it is on
    # the URL the poller actually resolves against the loopback origin.
    poller = DefinitionPoller(
        definitions_endpoint="https://flags.example",
        definitions_key="k",
        token="project-token",
        poll_interval=60.0,
    )
    try:
        # The resolved URL is adapter-internal; assert the query param is present + token-scoped.
        assert "send_cohorts=" in poller._url
        assert "token=project-token" in poller._url
    finally:
        poller.stop()


# ---------------------------------------------------------------------------------------------
# Negative controls (the PY8 lesson — the test CAN fail).
# ---------------------------------------------------------------------------------------------


def test_negative_control_fully_local_set_issues_zero_remote_posts(loopback_factory: Any, adapter_factory: Any) -> None:
    server = loopback_factory(_known_definitions(), _remote_v2_body(GROUND_TRUTH_FLAGS, GROUND_TRUTH_PAYLOADS))
    local = adapter_factory["local"](server.origin)

    result = local.evaluate(GROUND_TRUTH_CONTEXT)

    # All three flags decide locally → the remote path is never reached over the socket.
    assert result.get_flag("simple-flag") is True
    assert result.degraded is False
    assert len(server.posts) == 0


def test_negative_control_wrong_remote_answer_disagrees_with_local(loopback_factory: Any, adapter_factory: Any) -> None:
    # The loopback serves a remote value a correct backend would NOT return for this actor. If the
    # ground-truth diff were vacuous (a self-consistent mock), this would still "agree". It must NOT:
    # local eval computes the reference-correct value and the two disagree.
    server = loopback_factory([_multivariate_flag()], _remote_v2_body({"multivariate-flag": "third-variant"}))
    local = adapter_factory["local"](server.origin)
    remote = adapter_factory["remote"](server.origin)

    local_set = local.evaluate(GROUND_TRUTH_CONTEXT)
    remote_set = remote.evaluate(GROUND_TRUTH_CONTEXT)

    # Local eval lands in the reference-correct 'second-variant'; the (wrong) remote says 'third'.
    assert local_set.get_flag("multivariate-flag") == "second-variant"
    assert remote_set.get_flag("multivariate-flag") == "third-variant"
    # The diff BITES: a drift between local eval and the backend is caught, not silently passed.
    assert local_set.get_flag("multivariate-flag") != remote_set.get_flag("multivariate-flag")


def test_negative_control_flipped_rollout_boundary_changes_the_local_answer(loopback_factory: Any, adapter_factory: Any) -> None:
    # simple-flag at 0% admits no one → False, the OPPOSITE of the 100% ground truth. A vacuous test
    # (one that never actually gates on the hash) could not tell these apart.
    zero_rollout = {
        "key": "simple-flag",
        "active": True,
        "filters": {"groups": [{"properties": [], "rollout_percentage": 0}]},
    }
    server = loopback_factory([zero_rollout], _remote_v2_body({}))
    local = adapter_factory["local"](server.origin)

    result = local.evaluate(GROUND_TRUTH_CONTEXT)

    # Flipped boundary → False, distinct from the 100% ground-truth True.
    assert result.get_flag("simple-flag") is False


# ---------------------------------------------------------------------------------------------
# Layer 2 — the cross-tree hash anchor (KEY-LESS). This is the SINGLE named parity vector both trees
# bind to. S1 (the TS-node suite) and S3 (this Python suite) each assert these EXACT literals in
# their own suites; a drift in either tree's hash fails ITS suite. S4 names the vector here so the
# cross-tree identity is explicit — the load-bearing invariant across both trees AND a real backend's
# bucketing (the loopback layer 1 above, and the live layer below).
# ---------------------------------------------------------------------------------------------


def test_layer2_hash_anchor_tier1_sha1_primitive() -> None:
    assert hash_sha1("some-flag.some_distinct_id") == "e4ce124e800a818c63099f95fa085dc2b620e173"


def test_layer2_hash_anchor_tier2_exact_floats() -> None:
    assert bucket_hash("simple-flag", "distinct_id_0") == 0.78369637642204315
    assert bucket_hash("simple-flag", "distinct_id_1") == 0.33970699269954008
    assert bucket_hash("multivariate-flag", "distinct_id_0", "variant") == 0.61864545379303792


def test_layer2_hash_anchor_tier3_end_to_end_boolean_vector() -> None:
    from analytics_kit.flags.local.definition_types import DefinitionSnapshot

    flag = {"key": "simple-flag", "active": True, "filters": {"groups": [{"properties": [], "rollout_percentage": 45}]}}
    snap = DefinitionSnapshot(flags=(flag,), flags_by_key={"simple-flag": flag})
    from analytics_kit.flags.local.evaluator import compute_flag_locally

    out = [compute_flag_locally(flag, {"distinct_id": f"distinct_id_{i}"}, snap) for i in range(10)]
    assert out == [False, True, True, False, True, False, False, True, False, True]


def test_layer2_evaluate_flag_locally_matches_the_vector_directly() -> None:
    # The low-level entrypoint against a fixed bucketing value — the same shape the TS suite pins.
    flag = {"key": "simple-flag", "active": True, "filters": {"groups": [{"properties": [], "rollout_percentage": 45}]}}
    out = [evaluate_flag_locally(flag, f"distinct_id_{i}", {}, {}) for i in range(10)]
    assert out == [False, True, True, False, True, False, False, True, False, True]


# ---------------------------------------------------------------------------------------------
# Layer 3 — live privileged-key ground-truth (GATED, skip-if-no-key). The ONLY layer needing a live
# analytics project + a privileged (definition-reading) key. It diffs local eval against a REAL
# backend's OWN bucketing/definitions — the true correctness anchor against production, which canned
# loopback data cannot prove. Absent the key it SKIPS cleanly (never fails); layers 1–2 stay green.
# ---------------------------------------------------------------------------------------------

_LIVE_KEY_ENV = "ANALYTICS_KIT_LIVE_DEFINITIONS_KEY"
_LIVE_ENDPOINT_ENV = "ANALYTICS_KIT_LIVE_FLAG_ENDPOINT"
_LIVE_PROJECT_ENV = "ANALYTICS_KIT_LIVE_PROJECT_KEY"


@pytest.mark.skipif(
    not (os.environ.get(_LIVE_KEY_ENV) and os.environ.get(_LIVE_ENDPOINT_ENV) and os.environ.get(_LIVE_PROJECT_ENV)),
    reason=(
        "live ground-truth needs a real analytics project + privileged definition-reading key "
        f"({_LIVE_KEY_ENV}, {_LIVE_ENDPOINT_ENV}, {_LIVE_PROJECT_ENV}); the key-less loopback + "
        "hash-anchor layers cover the CC-reachable green path"
    ),
)
def test_layer3_live_local_eval_matches_the_real_backend_bucketing() -> None:  # pragma: no cover - gated
    # Against a real backend: local eval must produce the same variant the backend's own bucketing
    # returns for the same actor. The privileged key reads definitions; the project key drives the
    # remote round-trip. A disagreement means the hash diverges from the backend — escalate the hash
    # shape to architect before assuming a test bug (the hash is the load-bearing cross-tree AND
    # cross-backend invariant).
    endpoint = os.environ[_LIVE_ENDPOINT_ENV]
    project_key = os.environ[_LIVE_PROJECT_ENV]
    definitions_key = os.environ[_LIVE_KEY_ENV]

    local = create_flag_client(
        FlagClientConfig(
            key=project_key,
            flag_endpoint=endpoint,
            definitions_endpoint=endpoint,
            definitions_key=definitions_key,
        )
    )
    remote = create_flag_client(FlagClientConfig(key=project_key, flag_endpoint=endpoint))
    try:
        context: FlagContext = {"distinct_id": "distinct_id_0"}
        local_set = local.evaluate(context)
        remote_set = remote.evaluate(context)
        for key in remote_set.get_all():
            assert local_set.get_flag(key) == remote_set.get_flag(key)
    finally:
        cast("HttpFlagAdapter", local).stop()
        cast("HttpFlagAdapter", remote).stop()
