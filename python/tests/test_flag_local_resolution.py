"""E13-S3 tests for the Python local/remote resolution + fallback in HttpFlagAdapter.

The Python analog of S2, mirrored on the SYNCHRONOUS ``evaluate`` (a bare ``FlagSet``, never a
coroutine — the locked no-asyncio posture, asserted below). Every assertion runs against INJECTED
mock transports (a definitions GET transport + a flag-eval POST transport) — NEVER a live backend or
live key. The tests pin: ``evaluate`` stays synchronous + satisfies the frozen ``FeatureFlagPort``;
local-first resolves WITHOUT a round-trip (call-count asserted); an inconclusive flag falls back to
the SHIPPED ``_round_trip`` (narrowed to the fallback set); ``only_evaluate_locally`` suppresses the
fallback; a local flag and a remote flag are INDISTINGUISHABLE (same ``degraded``/``reason``);
``distinct_id`` still required pre-eval; ``on_change`` fires once; the factory local-only edge; and
the poll thread does NOT leak (``stop()`` in teardown).
"""

from __future__ import annotations

import inspect
import json
from collections.abc import Iterator
from typing import Any, cast

import pytest

from analytics_kit import (
    FeatureFlagPort,
    FlagClientConfig,
    FlagNoop,
    NeutralResponse,
    create_flag_client,
    create_server_analytics,
)
from analytics_kit.flags.adapter import HttpFlagAdapter, LocalEvalCapability
from analytics_kit.flags.local.definition_poller import DefinitionPoller


class _CountingTransport:
    """A mock transport routing GET (definitions) and POST (flag-eval) to canned responses and
    counting each. Never touches a network.

    ``get_response`` answers the definitions GET; ``post_response`` answers the flag-eval POST.
    ``post_count`` is the load-bearing assertion surface — a locally-decidable flag must issue ZERO
    POSTs.
    """

    def __init__(self, *, get_response: NeutralResponse, post_response: NeutralResponse) -> None:
        self._get_response = get_response
        self._post_response = post_response
        self.get_count = 0
        self.post_count = 0
        self.post_bodies: list[dict[str, Any]] = []

    def send(self, url: str, method: str, headers: dict[str, str], body: str | None = None) -> NeutralResponse:
        if method == "GET":
            self.get_count += 1
            return self._get_response
        self.post_count += 1
        if body is not None:
            self.post_bodies.append(json.loads(body))
        return self._post_response


def _definitions_body(*flags: dict[str, Any], cohorts: dict[str, Any] | None = None) -> str:
    return json.dumps({"flags": list(flags), "group_type_mapping": {}, "cohorts": cohorts or {}})


def _local_flag(key: str, rollout: int, **filters: Any) -> dict[str, Any]:
    return {"key": key, "active": True, "filters": {"groups": [{"properties": [], "rollout_percentage": rollout}], **filters}}


def _prop_flag(key: str, prop_key: str, prop_value: str) -> dict[str, Any]:
    return {
        "key": key,
        "active": True,
        "filters": {"groups": [{"properties": [{"key": prop_key, "value": prop_value}], "rollout_percentage": 100}]},
    }


def _remote_response(flags: dict[str, Any]) -> NeutralResponse:
    entries = {
        k: ({"enabled": True, "variant": v} if isinstance(v, str) else {"enabled": v, "variant": None})
        for k, v in flags.items()
    }
    return NeutralResponse(status=200, body=json.dumps({"flags": entries}))


def _build_local_adapter(
    transport: _CountingTransport,
    *,
    flag_endpoint: str | None = "https://flags.example",
    only_locally: bool = False,
) -> Iterator[HttpFlagAdapter]:
    poller = DefinitionPoller(
        definitions_endpoint="https://flags.example",
        definitions_key="privileged-key",
        token="proj-token",
        poll_interval=60.0,
        transport=cast("Any", transport),
    )
    adapter = HttpFlagAdapter(
        key="proj-token",
        flag_endpoint=flag_endpoint,
        transport=cast("Any", transport),
        local=LocalEvalCapability(poller, only_locally),
    )
    try:
        yield adapter
    finally:
        adapter.stop()  # the E12-S4 lesson: stop the poll thread in teardown — no leaked thread.


@pytest.fixture
def local_adapter_factory() -> Any:
    created: list[HttpFlagAdapter] = []

    def make(transport: _CountingTransport, *, flag_endpoint: str | None = "https://flags.example", only_locally: bool = False) -> HttpFlagAdapter:
        gen = _build_local_adapter(transport, flag_endpoint=flag_endpoint, only_locally=only_locally)
        adapter = next(gen)
        created.append(adapter)
        return adapter

    yield make
    for adapter in created:
        adapter.stop()


# --- evaluate stays synchronous, satisfies the frozen port ---------------------------------------


def test_evaluate_is_synchronous_by_design_with_local_eval() -> None:
    # The load-bearing parity call: even with the local strategy branch, evaluate is a plain def
    # returning a bare FlagSet — never a coroutine. A future reader must NOT push this toward asyncio.
    assert not inspect.iscoroutinefunction(HttpFlagAdapter.evaluate)


def test_local_capable_adapter_satisfies_the_neutral_port(local_adapter_factory: Any) -> None:
    transport = _CountingTransport(
        get_response=NeutralResponse(status=200, body=_definitions_body(_local_flag("f", 100))),
        post_response=_remote_response({}),
    )
    adapter: FeatureFlagPort = local_adapter_factory(transport)
    assert callable(adapter.evaluate)
    assert callable(adapter.on_change)


# --- local-first resolves WITHOUT a round-trip ---------------------------------------------------


def test_local_first_resolves_without_a_round_trip(local_adapter_factory: Any) -> None:
    transport = _CountingTransport(
        get_response=NeutralResponse(status=200, body=_definitions_body(_local_flag("simple-flag", 100))),
        post_response=_remote_response({"simple-flag": False}),  # would DISAGREE if it were consulted
    )
    adapter = local_adapter_factory(transport)

    snapshot = adapter.evaluate({"distinct_id": "distinct_id_0"})

    assert snapshot.get_flag("simple-flag") is True
    assert snapshot.degraded is False
    assert snapshot.reason("simple-flag") == "resolved"
    # The load-bearing assertion: a locally-decidable flag issued ZERO flag-eval POSTs.
    assert transport.post_count == 0
    assert transport.get_count >= 1


def test_local_resolved_flag_carries_its_payload(local_adapter_factory: Any) -> None:
    flag = _local_flag("paid", 100)
    flag["filters"]["payloads"] = {"true": json.dumps({"tier": "gold"})}
    transport = _CountingTransport(
        get_response=NeutralResponse(status=200, body=_definitions_body(flag)),
        post_response=_remote_response({}),
    )
    adapter = local_adapter_factory(transport)
    snapshot = adapter.evaluate({"distinct_id": "distinct_id_0"})
    assert snapshot.get_flag("paid") is True
    assert snapshot.get_payload("paid") == {"tier": "gold"}
    assert transport.post_count == 0


# --- inconclusive -> ONE narrowed round-trip -----------------------------------------------------


def test_inconclusive_flag_falls_back_to_one_narrowed_round_trip(local_adapter_factory: Any) -> None:
    local = _local_flag("simple-flag", 100)  # locally decidable
    remote_only = _prop_flag("needs-prop", "plan", "pro")  # needs an absent prop -> inconclusive
    transport = _CountingTransport(
        get_response=NeutralResponse(status=200, body=_definitions_body(local, remote_only)),
        post_response=_remote_response({"needs-prop": "variant-x"}),
    )
    adapter = local_adapter_factory(transport)

    snapshot = adapter.evaluate({"distinct_id": "distinct_id_0"})

    # The merged snapshot carries BOTH: the local flag (resolved locally) and the remote flag.
    assert snapshot.get_flag("simple-flag") is True
    assert snapshot.get_flag("needs-prop") == "variant-x"
    # Exactly ONE round-trip, narrowed to the fallback set (only the unresolved key on the wire).
    assert transport.post_count == 1
    assert transport.post_bodies[0]["flag_keys_to_evaluate"] == ["needs-prop"]


def test_static_cohort_falls_back_to_remote(local_adapter_factory: Any) -> None:
    cohort_flag = {
        "key": "cohort-flag",
        "active": True,
        "filters": {"groups": [{"properties": [{"key": "id", "type": "cohort", "value": "999"}], "rollout_percentage": 100}]},
    }
    transport = _CountingTransport(
        get_response=NeutralResponse(status=200, body=_definitions_body(cohort_flag, cohorts={})),
        post_response=_remote_response({"cohort-flag": True}),
    )
    adapter = local_adapter_factory(transport)
    snapshot = adapter.evaluate({"distinct_id": "u"})
    # A static cohort (RequiresServerEvaluation) also routes to the remote fallback.
    assert snapshot.get_flag("cohort-flag") is True
    assert transport.post_count == 1


def test_unknown_requested_key_drops_out_not_a_fallback_key(local_adapter_factory: Any) -> None:
    transport = _CountingTransport(
        get_response=NeutralResponse(status=200, body=_definitions_body(_local_flag("simple-flag", 100))),
        post_response=_remote_response({}),
    )
    adapter = local_adapter_factory(transport)
    # 'ghost' has no local definition — a requested key with no definition drops out, it does NOT
    # become a fallback key on its own, so no round-trip fires.
    snapshot = adapter.evaluate({"distinct_id": "distinct_id_0", "flag_keys": ["simple-flag", "ghost"]})
    assert snapshot.get_flag("simple-flag") is True
    assert snapshot.get_flag("ghost") is None
    assert transport.post_count == 0


# --- only_evaluate_locally suppresses the fallback -----------------------------------------------


def test_only_evaluate_locally_suppresses_the_fallback(local_adapter_factory: Any) -> None:
    local = _local_flag("simple-flag", 100)
    remote_only = _prop_flag("needs-prop", "plan", "pro")
    transport = _CountingTransport(
        get_response=NeutralResponse(status=200, body=_definitions_body(local, remote_only)),
        post_response=_remote_response({"needs-prop": True}),
    )
    adapter = local_adapter_factory(transport, only_locally=True)

    snapshot = adapter.evaluate({"distinct_id": "distinct_id_0"})

    # The local flag resolves; the inconclusive flag stays absent (no round-trip), and the snapshot
    # degrades because a requested flag could not be resolved.
    assert snapshot.get_flag("simple-flag") is True
    assert snapshot.get_flag("needs-prop") is None
    assert snapshot.degraded is True
    assert snapshot.reason("simple-flag") == "unresolved"
    assert transport.post_count == 0


# --- local vs remote INDISTINGUISHABLE -----------------------------------------------------------


def test_local_and_remote_flags_are_indistinguishable_on_a_clean_snapshot(local_adapter_factory: Any) -> None:
    # A purely-local resolvable set and a purely-remote resolvable set read identically: same degraded
    # (False), same reason ('resolved'), same is_enabled/get_flag semantics.
    local_transport = _CountingTransport(
        get_response=NeutralResponse(status=200, body=_definitions_body(_local_flag("simple-flag", 100))),
        post_response=_remote_response({}),
    )
    local_adapter = local_adapter_factory(local_transport)
    local_snap = local_adapter.evaluate({"distinct_id": "distinct_id_0"})

    remote_adapter = HttpFlagAdapter(
        key="k",
        flag_endpoint="https://flags.example",
        transport=cast("Any", _CountingTransport(get_response=_remote_response({}), post_response=_remote_response({"simple-flag": True}))),
    )
    remote_snap = remote_adapter.evaluate({"distinct_id": "distinct_id_0"})

    assert local_snap.get_flag("simple-flag") == remote_snap.get_flag("simple-flag") is True
    assert local_snap.degraded == remote_snap.degraded is False
    assert local_snap.reason("simple-flag") == remote_snap.reason("simple-flag") == "resolved"
    assert local_snap.is_enabled("simple-flag") == remote_snap.is_enabled("simple-flag") is True


def test_local_failure_reads_identically_to_a_remote_failure(local_adapter_factory: Any) -> None:
    # A fallback flag whose round-trip FAILS degrades the whole snapshot uniformly — a clean local
    # flag then reads the SAME degraded/reason as a wholesale remote failure.
    local = _local_flag("simple-flag", 100)
    remote_only = _prop_flag("needs-prop", "plan", "pro")
    transport = _CountingTransport(
        get_response=NeutralResponse(status=200, body=_definitions_body(local, remote_only)),
        post_response=NeutralResponse(status=500, body="down"),  # the fallback round-trip fails
    )
    adapter = local_adapter_factory(transport)

    snapshot = adapter.evaluate({"distinct_id": "distinct_id_0"})

    # Degraded-WINS on mixed: the clean local flag adopts the round-trip's degraded/unresolved state.
    assert snapshot.get_flag("simple-flag") is True  # still present
    assert snapshot.get_flag("needs-prop") is None  # the failed fallback never resolved
    assert snapshot.degraded is True
    assert snapshot.reason("simple-flag") == "unresolved"
    assert transport.post_count == 1


def test_mixed_local_plus_stale_bootstrap_fallback_reads_stale(local_adapter_factory: Any) -> None:
    # The S2 reviewer's mixed-bootstrap case, on the sync path: a local flag resolves, the fallback's
    # round-trip fails, the bootstrap seed is served as 'stale' -> the whole snapshot reads
    # 'stale'+degraded (snapshot-uniform reason), including the clean local flag.
    from analytics_kit import FlagBootstrap

    local = _local_flag("simple-flag", 100)
    remote_only = _prop_flag("needs-prop", "plan", "pro")
    transport = _CountingTransport(
        get_response=NeutralResponse(status=200, body=_definitions_body(local, remote_only)),
        post_response=NeutralResponse(status=503, body="down"),
    )
    poller = DefinitionPoller(
        definitions_endpoint="https://flags.example",
        definitions_key="k",
        token="proj-token",
        poll_interval=60.0,
        transport=cast("Any", transport),
    )
    adapter = HttpFlagAdapter(
        key="proj-token",
        flag_endpoint="https://flags.example",
        bootstrap=FlagBootstrap(flags={"needs-prop": True}, payloads={}),
        transport=cast("Any", transport),
        local=LocalEvalCapability(poller, only_locally=False),
    )
    try:
        snapshot = adapter.evaluate({"distinct_id": "distinct_id_0"})
        assert snapshot.get_flag("simple-flag") is True
        assert snapshot.get_flag("needs-prop") is True  # served from the stale bootstrap seed
        assert snapshot.degraded is True
        assert snapshot.reason("simple-flag") == "stale"
    finally:
        adapter.stop()


# --- distinct_id required pre-eval + on_change once ----------------------------------------------


def test_distinct_id_required_still_raises_pre_eval_under_local_eval(local_adapter_factory: Any) -> None:
    transport = _CountingTransport(
        get_response=NeutralResponse(status=200, body=_definitions_body(_local_flag("simple-flag", 100))),
        post_response=_remote_response({}),
    )
    adapter = local_adapter_factory(transport)
    with pytest.raises(ValueError, match="distinct_id"):
        adapter.evaluate()
    with pytest.raises(ValueError):
        adapter.evaluate({"distinct_id": ""})
    # No flag-eval round-trip was ever issued.
    assert transport.post_count == 0


def test_on_change_fires_once_under_local_eval(local_adapter_factory: Any) -> None:
    transport = _CountingTransport(
        get_response=NeutralResponse(status=200, body=_definitions_body(_local_flag("simple-flag", 100))),
        post_response=_remote_response({}),
    )
    adapter = local_adapter_factory(transport)
    received: list[object] = []
    adapter.on_change(received.append)
    adapter.evaluate({"distinct_id": "distinct_id_0"})
    adapter.evaluate({"distinct_id": "distinct_id_1"})  # second evaluate does NOT re-fire
    assert len(received) == 1


def test_not_ready_falls_back_to_remote_with_the_original_context() -> None:
    # Before the poller is ready, a local-capable adapter (not local-only) falls to the shipped remote
    # path with the ORIGINAL untouched context — the definitions GET here returns a malformed body so
    # is_ready() stays False.
    transport = _CountingTransport(
        get_response=NeutralResponse(status=200, body="not json"),
        post_response=_remote_response({"remote-flag": True}),
    )
    poller = DefinitionPoller(
        definitions_endpoint="https://flags.example",
        definitions_key="k",
        token="proj-token",
        poll_interval=60.0,
        transport=cast("Any", transport),
    )
    adapter = HttpFlagAdapter(
        key="proj-token",
        flag_endpoint="https://flags.example",
        transport=cast("Any", transport),
        local=LocalEvalCapability(poller, only_locally=False),
    )
    try:
        snapshot = adapter.evaluate({"distinct_id": "u"})
        assert snapshot.get_flag("remote-flag") is True
        assert transport.post_count == 1
    finally:
        adapter.stop()


# --- the config-selected factory (bar B) — local-only edge ---------------------------------------


def test_factory_local_config_selects_the_local_capable_adapter() -> None:
    client = create_flag_client(
        FlagClientConfig(
            key="k",
            flag_endpoint="https://flags.example",
            definitions_endpoint="https://flags.example",
            definitions_key="privileged",
        )
    )
    try:
        assert isinstance(client, HttpFlagAdapter)
    finally:
        cast("HttpFlagAdapter", client).stop()


def test_factory_local_only_without_a_flag_endpoint_selects_the_adapter_not_the_noop() -> None:
    # The local-only posture: key + definitions endpoint + privileged credential but NO flag_endpoint
    # must select the local-capable adapter, NOT the no-op (the relaxed factory edge).
    client = create_flag_client(
        FlagClientConfig(
            key="k",
            definitions_endpoint="https://flags.example",
            definitions_key="privileged",
            only_evaluate_locally=True,
        )
    )
    try:
        assert isinstance(client, HttpFlagAdapter)
    finally:
        cast("HttpFlagAdapter", client).stop()


def test_factory_keyed_but_no_endpoint_and_no_local_config_is_the_noop() -> None:
    # Genuinely nowhere to evaluate: key set, neither a flag_endpoint nor a local-eval config.
    client = create_flag_client(FlagClientConfig(key="k"))
    assert isinstance(client, FlagNoop)


def test_factory_definitions_endpoint_without_the_privileged_key_is_not_local_capable() -> None:
    # A definitions endpoint alone (no privileged credential) is NOT enough — falls to remote-only,
    # or the no-op when there's also no flag_endpoint.
    client = create_flag_client(FlagClientConfig(key="k", definitions_endpoint="https://flags.example"))
    assert isinstance(client, FlagNoop)


def test_effective_only_locally_defaults_from_strict_local_evaluation() -> None:
    # only_evaluate_locally ?? strict_local_evaluation ?? False — strict makes local-only the default.
    client = create_flag_client(
        FlagClientConfig(
            key="k",
            definitions_endpoint="https://flags.example",
            definitions_key="privileged",
            strict_local_evaluation=True,
        )
    )
    try:
        assert isinstance(client, HttpFlagAdapter)
        assert client._local is not None
        assert client._local.only_locally is True
    finally:
        cast("HttpFlagAdapter", client).stop()


# --- the provider flags slot (server target) selects local-capable -------------------------------


def test_server_provider_flags_slot_is_local_capable_via_config() -> None:
    analytics = create_server_analytics(
        {
            "key": "k",
            "ingest_host": "https://ingest.example",
            "sync_mode": True,
            "flags": {
                "definitions_endpoint": "https://flags.example",
                "definitions_key": "privileged",
                "only_evaluate_locally": True,
            },
        }
    )
    try:
        assert isinstance(analytics.flags, HttpFlagAdapter)
        assert analytics.flags._local is not None
    finally:
        cast("HttpFlagAdapter", analytics.flags).stop()


def test_server_provider_local_only_slot_populated_without_a_flag_endpoint() -> None:
    # The local-only posture via the server target: a definitions endpoint + credential, no
    # flag_endpoint, still attaches a local-capable client (not None).
    analytics = create_server_analytics(
        {
            "key": "k",
            "ingest_host": "https://ingest.example",
            "sync_mode": True,
            "flags": {"definitions_endpoint": "https://flags.example", "definitions_key": "privileged"},
        }
    )
    try:
        assert analytics.flags is not None
        assert isinstance(analytics.flags, HttpFlagAdapter)
    finally:
        cast("HttpFlagAdapter", analytics.flags).stop()
