"""Flag exercise: the neutral feature-flag port through a fake transport + a fake port (PY parity).

Quillstream exercises the shipped flag surface (E12-S1..S5) BY CONFIG ALONE, mirroring the
``test_query_exercise.py`` fake-satisfies-the-Protocol pattern (Quillstream carries no ``bar-a``/
``bar-b``-named test to extend):

- **Real remote adapter** — ``create_flag_client`` with a keyed + endpointed ``FlagClientConfig``
  and an injected ``FakeFlagTransport`` returning a canned wire body (so the real ``HttpFlagAdapter``
  is selected, NOT the silent no-op). Assertions land on the neutral ``FlagSet`` reads only.
- **Slot path** — ``create_server_analytics(cfg).flags`` when the ingest config carries
  ``flags.flag_endpoint`` (bar B — config-only adoption populates the provider slot).
- **``distinct_id``-required** — the server asymmetry: ``evaluate`` with no ``distinct_id`` raises a
  neutral ``ValueError`` BEFORE any network, and the transport is never consulted.
- **Bar-A swap** — a ``FakeFlagPort`` satisfying ``FeatureFlagPort`` swapped in with byte-identical
  consumer read code; the same reads resolve against the real adapter and the fake.
- **Bar-B no-op** — an unkeyed (or endpointless) config selects the ``FlagNoop``: ``evaluate``
  resolves the ``unresolved`` empty snapshot and never touches the transport (the flag footgun).

No socket is ever opened. Presence of the neutral port + adapter surface is recorded here (Python
carries no ``capability-presence`` file — the imports + the smoke exercise ARE the presence record).
"""

from __future__ import annotations

import json
from collections.abc import Callable

import pytest

from analytics_kit import (
    FeatureFlagPort,
    FlagContext,
    FlagEvaluateOptions,
    FlagSet,
    FlagValue,
    NeutralResponse,
    create_flag_client,
    empty_flag_set,
)
from analytics_kit.server import create_server_analytics

from quillstream.config import (
    quillstream_config_with_flags,
    quillstream_flag_config,
)

# The canned wire response the fake transport returns — the Python remote adapter's wire shape:
# a per-flag object map exposing enabled/variant and a JSON-string payload under metadata.
_WIRE_BODY: dict[str, object] = {
    "flags": {
        "ai_draft_assist": {
            "enabled": True,
            "variant": "detailed",
            "metadata": {"payload": json.dumps({"model": "review-9", "max_tokens": 1024})},
        },
        "bulk_publish": {"enabled": False},
    }
}


class FakeFlagTransport:
    """A recording flag transport standing in for the backend — satisfies ``FlagTransport``.

    ``send`` records each request and returns a ``NeutralResponse(status=200, body=<JSON>)`` the
    adapter decodes into a ``FlagSet``. Never opens a socket.
    """

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str | None]] = []

    def send(
        self,
        url: str,
        method: str,
        headers: dict[str, str],
        body: str | None = None,
    ) -> NeutralResponse:
        self.calls.append((url, method, body))
        return NeutralResponse(status=200, body=json.dumps(_WIRE_BODY))


class FakeFlagPort:
    """A fake ``FeatureFlagPort`` over a canned snapshot — the bar-A swap target.

    Consumer flag reads are byte-identical whether they run against this fake or the real remote
    adapter; the fake exists ONLY to prove that swap-equivalence (no network, no bootstrap timing).
    """

    def __init__(self, flags: dict[str, FlagValue], payloads: dict[str, object] | None = None) -> None:
        self._flags = flags
        self._payloads = payloads or {}

    def evaluate(
        self,
        context: FlagContext | None = None,
        options: FlagEvaluateOptions | None = None,
    ) -> FlagSet:
        return _FakeSnapshot(self._flags, self._payloads)

    def on_change(self, listener: Callable[[FlagSet], None]) -> Callable[[], None]:
        listener(_FakeSnapshot(self._flags, self._payloads))
        return lambda: None


class _FakeSnapshot:
    """A minimal ``FlagSet`` over canned data for the fake port."""

    def __init__(self, flags: dict[str, FlagValue], payloads: dict[str, object]) -> None:
        self._flags = flags
        self._payloads = payloads

    def is_enabled(self, key: str) -> bool:
        value = self._flags.get(key)
        return value is not None and value is not False

    def get_flag(self, key: str) -> FlagValue | None:
        return self._flags.get(key)

    def get_payload(self, key: str) -> object:
        return self._payloads.get(key)

    def get_all(self) -> dict[str, FlagValue]:
        return dict(self._flags)

    @property
    def degraded(self) -> bool:
        return False

    def reason(self, key: str) -> str | None:
        if key in self._flags or key in self._payloads:
            return "resolved"
        return None


# A byte-identical consumer read: the same function is run against the real adapter AND the fake
# port (bar A). It reads only the neutral FlagSet surface.
def _read_variant(flags: FeatureFlagPort) -> FlagValue | None:
    return flags.evaluate({"distinct_id": "author-1"}).get_flag("ai_draft_assist")


def _keyed_flag_client(transport: FakeFlagTransport) -> FeatureFlagPort:
    config = quillstream_flag_config(key="quillstream-flag-key")
    return create_flag_client(config.model_copy(update={"transport": transport}))


def test_keyed_and_endpointed_config_selects_the_real_adapter_and_consults_the_transport() -> None:
    transport = FakeFlagTransport()
    client = _keyed_flag_client(transport)

    client.evaluate({"distinct_id": "author-1"})

    # The real remote adapter branch was selected (key + endpoint), so the injected transport was
    # consulted — proving these assertions are NOT the vacuous FlagNoop path.
    assert len(transport.calls) == 1
    url, method, _body = transport.calls[0]
    assert url == "https://analytics.quillstream.example/flags/?v=2"
    assert method == "POST"


def test_evaluate_resolves_the_neutral_flag_set_with_typed_payload() -> None:
    transport = FakeFlagTransport()
    flag_set = _keyed_flag_client(transport).evaluate({"distinct_id": "author-1"})

    # evaluate is SYNC (no await) and returns a bare FlagSet — the S1/S4 locked Python-sync port.
    assert flag_set.get_flag("ai_draft_assist") == "detailed"
    assert flag_set.is_enabled("ai_draft_assist") is True
    assert flag_set.is_enabled("bulk_publish") is False
    assert flag_set.get_payload("ai_draft_assist") == {"model": "review-9", "max_tokens": 1024}
    assert flag_set.reason("ai_draft_assist") == "resolved"
    assert flag_set.degraded is False
    assert set(flag_set.get_all()) == {"ai_draft_assist", "bulk_publish"}


def test_on_change_fires_once_with_the_resolved_set() -> None:
    transport = FakeFlagTransport()
    client = _keyed_flag_client(transport)

    seen: list[FlagSet] = []
    client.on_change(seen.append)

    # The stateless server fires once, on the first evaluate's resolved snapshot.
    client.evaluate({"distinct_id": "author-1"})
    assert len(seen) == 1
    assert seen[0].get_flag("ai_draft_assist") == "detailed"

    # A second evaluate (a fresh actor) does NOT re-fire — the server once-fire cardinality.
    client.evaluate({"distinct_id": "author-2"})
    assert len(seen) == 1


def test_distinct_id_is_required_on_the_server_and_throws_pre_network() -> None:
    transport = FakeFlagTransport()
    client = _keyed_flag_client(transport)

    # The server asymmetry: no ambient actor. A missing distinct_id is a caller error raised BEFORE
    # any network, and no wire body is built — the transport is never consulted.
    with pytest.raises(ValueError, match="distinct_id is required"):
        client.evaluate({})
    assert transport.calls == []


def test_bar_a_mock_swap_resolves_the_same_reads_with_zero_consumer_change() -> None:
    transport = FakeFlagTransport()
    real = _keyed_flag_client(transport)
    assert _read_variant(real) == "detailed"

    # Swap to a fake FeatureFlagPort with byte-identical consumer code (_read_variant) — bar A.
    fake = FakeFlagPort({"ai_draft_assist": "concise", "bulk_publish": True})
    assert _read_variant(fake) == "concise"


def test_bar_b_slot_path_populates_flags_from_config_alone() -> None:
    # create_server_analytics(cfg).flags is populated when the ingest config carries
    # flags.flag_endpoint (bar B — config-only adoption populates the provider slot). Dropping the
    # endpoint leaves the slot at its None default. Use sync_mode so no daemon delivery thread leaks.
    # (We assert slot POPULATION only — evaluate() over the real endpoint would attempt a socket;
    # the round-trip behavior is proven via the injected-transport client above.)
    keyed = quillstream_config_with_flags(key="quillstream-ingest-key").model_copy(
        update={"sync_mode": True}
    )
    analytics = create_server_analytics(keyed)
    try:
        assert analytics.flags is not None
        assert callable(analytics.flags.evaluate)
    finally:
        analytics.shutdown()

    endpointless = quillstream_config_with_flags(
        key="quillstream-ingest-key", flag_endpoint=None
    ).model_copy(update={"sync_mode": True})
    analytics_no_flags = create_server_analytics(endpointless)
    try:
        # No flag endpoint ⇒ the slot stays the None default — feature-flags off by config alone.
        assert analytics_no_flags.flags is None
    finally:
        analytics_no_flags.shutdown()


def test_bar_b_unkeyed_config_gets_no_flags_gracefully() -> None:
    # An endpointless flag config selects the silent FlagNoop: evaluate resolves the 'unresolved'
    # empty snapshot and never touches a transport — the flag footgun, the config-only no-op posture.
    noop = create_flag_client(quillstream_flag_config(key="k", flag_endpoint=None))
    flag_set = noop.evaluate({"distinct_id": "author-1"})
    assert flag_set.degraded is True
    assert flag_set.reason("ai_draft_assist") == "unresolved"
    assert flag_set.get_all() == {}


def test_flag_port_and_adapter_surface_is_public_and_present() -> None:
    # Python has no capability-presence file — this asserts the neutral port + factory + null-object
    # are reachable on the public analytics_kit surface (the presence record for feature-flags).
    assert callable(create_flag_client)
    assert callable(empty_flag_set)
    # The empty snapshot is a real, safe-to-call FlagSet (the null-object contract).
    empty = empty_flag_set()
    assert empty.is_enabled("anything") is False
    assert empty.reason("anything") == "unresolved"
