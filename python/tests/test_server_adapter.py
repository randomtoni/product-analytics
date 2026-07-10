"""Tests for the server target adapter + the ``config.key`` adapter selection.

These pin the server ``AnalyticsAdapter`` realization: structural conformance to the shipped
Protocol, the capture→enqueue seam (already-minted events land on the sink, no re-minting),
the injectable-sink seam the batch queue slots into later, the neutral consent/identity
backing, and the two-piece target selection (keyed ⇒ the server adapter, unkeyed ⇒ the seam
no-op — bar B). The ``ingest_host``/``ingest_path`` config extension is pinned too.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from analytics_kit import (
    AnalyticsAdapter,
    AnalyticsConfig,
    ConsentState,
    NeutralEvent,
    NoopAdapter,
    ServerAdapter,
    __version__,
    create_analytics,
    create_server_analytics,
)
from analytics_kit.server.adapter import EventSink


def _conforms(adapter: AnalyticsAdapter) -> None:
    """Structural-conformance sink — mypy proves satisfaction without inheritance."""


class _RecordingSink:
    """An injected enqueue sink that records every event the adapter routes to it."""

    def __init__(self) -> None:
        self.events: list[NeutralEvent] = []

    def __call__(self, event: NeutralEvent) -> None:
        self.events.append(event)


# --- structural conformance to the shipped SPI -----------------------------------------


def test_server_adapter_conforms_to_spi_structurally() -> None:
    adapter = ServerAdapter(version=__version__)
    _conforms(adapter)
    assert AnalyticsAdapter not in type(adapter).__mro__


def test_server_adapter_has_every_spi_member() -> None:
    adapter = ServerAdapter(version=__version__)
    for member in (
        "capture",
        "flush",
        "shutdown",
        "send",
        "get_consent_state",
        "set_consent_state",
        "get_library_id",
        "get_library_version",
    ):
        assert callable(getattr(adapter, member))


# --- capture enqueues the already-minted event (no re-minting) --------------------------


def test_capture_enqueues_the_event_onto_the_sink() -> None:
    sink = _RecordingSink()
    adapter = ServerAdapter(version=__version__, sink=sink)
    event = NeutralEvent(event="signed_up", distinct_id="u1", dedupe_id="d1")

    adapter.capture(event)

    assert sink.events == [event]


def test_capture_does_not_re_mint_the_event() -> None:
    # The provider already minted the event; the adapter passes it through by identity —
    # dedupe_id, properties, timestamp, and internal_kind are untouched.
    sink = _RecordingSink()
    adapter = ServerAdapter(version=__version__, sink=sink)
    ts = datetime(2026, 7, 10, tzinfo=timezone.utc)
    event = NeutralEvent(
        event="set_traits",
        distinct_id="u1",
        dedupe_id="fixed-dedupe",
        properties={"set": {"plan": "pro"}},
        timestamp=ts,
        internal_kind="set_traits",
    )

    adapter.capture(event)

    delivered = sink.events[0]
    assert delivered is event
    assert delivered.dedupe_id == "fixed-dedupe"
    assert delivered.properties == {"set": {"plan": "pro"}}
    assert delivered.timestamp == ts
    assert delivered.internal_kind == "set_traits"


def test_capture_preserves_order_across_multiple_events() -> None:
    sink = _RecordingSink()
    adapter = ServerAdapter(version=__version__, sink=sink)
    first = NeutralEvent(event="a", distinct_id="u1", dedupe_id="d1")
    second = NeutralEvent(event="b", distinct_id="u1", dedupe_id="d2")

    adapter.capture(first)
    adapter.capture(second)

    assert sink.events == [first, second]


def test_default_sink_buffers_when_none_injected() -> None:
    # Absent an injected sink, capture enqueues onto the adapter's own in-memory buffer —
    # the seam PY4-S2's queue-backed consumer replaces by construction.
    adapter = ServerAdapter(version=__version__)
    event = NeutralEvent(event="signed_up", distinct_id="u1", dedupe_id="d1")

    adapter.capture(event)

    assert adapter._sink.events == [event]  # type: ignore[attr-defined]


def test_sink_is_a_plain_callable_seam() -> None:
    # The enqueue seam is a NeutralEvent -> None callable; a bare function satisfies it, so
    # PY4-S2 can inject a queue.put closure with no adapter reshaping.
    captured: list[NeutralEvent] = []

    def sink(event: NeutralEvent) -> None:
        captured.append(event)

    injected: EventSink = sink
    adapter = ServerAdapter(version=__version__, sink=injected)
    event = NeutralEvent(event="signed_up", distinct_id="u1", dedupe_id="d1")

    adapter.capture(event)

    assert captured == [event]


# --- lifecycle + send neutral primitive ------------------------------------------------


def test_lifecycle_verbs_are_callable_and_return_none() -> None:
    adapter = ServerAdapter(version=__version__)
    adapter.flush()
    adapter.shutdown()


def test_send_is_the_neutral_string_bodied_primitive() -> None:
    adapter = ServerAdapter(version=__version__)
    response = adapter.send("https://example.invalid", "POST", {}, "{}")
    assert response.status == 0
    assert response.body == ""


# --- consent backed by the adapter's own field -----------------------------------------


def test_consent_defaults_to_granted() -> None:
    adapter = ServerAdapter(version=__version__)
    assert adapter.get_consent_state() == "granted"


def test_set_consent_state_backs_the_adapter_field() -> None:
    adapter = ServerAdapter(version=__version__)

    adapter.set_consent_state("denied")
    assert adapter.get_consent_state() == "denied"

    adapter.set_consent_state("pending")
    assert adapter.get_consent_state() == "pending"


def test_consent_seed_via_constructor() -> None:
    seeded: ConsentState = "denied"
    adapter = ServerAdapter(version=__version__, consent=seeded)
    assert adapter.get_consent_state() == "denied"


# --- neutral library id / version (no vendor token) ------------------------------------


def test_library_id_is_neutral() -> None:
    adapter = ServerAdapter(version=__version__)
    assert adapter.get_library_id() == "analytics-kit"
    assert "posthog" not in adapter.get_library_id().lower()


def test_library_version_reports_the_supplied_version() -> None:
    adapter = ServerAdapter(version="9.9.9")
    assert adapter.get_library_version() == "9.9.9"
    assert "posthog" not in adapter.get_library_version().lower()


# --- config: ingest_host / ingest_path additive ----------------------------------------


def test_config_ingest_fields_default_to_none() -> None:
    config = AnalyticsConfig()
    assert config.ingest_host is None
    assert config.ingest_path is None


def test_config_accepts_ingest_host_and_path() -> None:
    config = AnalyticsConfig(ingest_host="https://ingest.example", ingest_path="/batch")
    assert config.ingest_host == "https://ingest.example"
    assert config.ingest_path == "/batch"


def test_config_ingest_fields_coexist_without_collision() -> None:
    config = AnalyticsConfig(
        key="k1",
        super_properties={"v": "1"},
        sync_mode=True,
        allowlist=["plan"],
        on_violation="drop-and-error-log",
        ingest_host="https://ingest.example",
        ingest_path="/batch",
    )
    assert config.key == "k1"
    assert config.super_properties == {"v": "1"}
    assert config.sync_mode is True
    assert config.allowlist == ["plan"]
    assert config.on_violation == "drop-and-error-log"
    assert config.ingest_host == "https://ingest.example"
    assert config.ingest_path == "/batch"


def test_config_rejects_wrong_ingest_host_type() -> None:
    with pytest.raises(ValidationError):
        AnalyticsConfig(ingest_host=123)  # type: ignore[arg-type]


def test_config_extra_forbid_still_bites_unknown_keys() -> None:
    # The additive fields do not loosen extra="forbid": a typo of one still raises loudly.
    with pytest.raises(ValidationError):
        AnalyticsConfig(ingest_hostt="https://ingest.example")  # type: ignore[call-arg]


# --- target selection: keyed ⇒ server adapter, unkeyed ⇒ seam no-op (bar B) -------------


def test_keyed_config_routes_to_a_server_adapter() -> None:
    provider = create_server_analytics(AnalyticsConfig(key="k1"))
    assert isinstance(provider._adapter, ServerAdapter)


def test_keyed_provider_captures_reach_the_server_adapter_sink() -> None:
    sink = _RecordingSink()
    adapter = ServerAdapter(version=__version__, sink=sink)
    provider = create_analytics(AnalyticsConfig(key="k1"), adapter)

    provider.capture("u1", "signed_up", {"plan": "pro"})

    assert len(sink.events) == 1
    assert sink.events[0].event == "signed_up"
    assert sink.events[0].distinct_id == "u1"


def test_unkeyed_config_routes_to_the_seam_noop() -> None:
    provider = create_server_analytics(AnalyticsConfig())
    assert isinstance(provider._adapter, NoopAdapter)


def test_unkeyed_provider_is_whole_stack_silent() -> None:
    # Bar B: an unconfigured environment sends nothing — every verb is a silent no-op.
    provider = create_server_analytics(AnalyticsConfig())

    provider.capture("u1", "signed_up", {"plan": "pro"})
    provider.set("u1", {"plan": "pro"})
    provider.set_group_traits("company", "acme", {"tier": "enterprise"})
    provider.flush()
    provider.shutdown()


def test_target_entry_accepts_a_dict_config() -> None:
    provider = create_server_analytics({"key": "k1"})
    assert isinstance(provider._adapter, ServerAdapter)


def test_target_entry_validates_config_and_raises_on_bad_input() -> None:
    with pytest.raises(ValidationError):
        create_server_analytics({"key": 123})


def test_target_entry_threads_config_through_to_the_provider() -> None:
    provider = create_server_analytics(
        AnalyticsConfig(key="k1", super_properties={"app_version": "1.2.3"})
    )
    adapter = provider._adapter
    assert isinstance(adapter, ServerAdapter)

    provider.capture("u1", "signed_up", {"plan": "pro"})

    assert adapter._sink.events[0].properties == {  # type: ignore[attr-defined]
        "app_version": "1.2.3",
        "plan": "pro",
    }
