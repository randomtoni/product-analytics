"""Provider verb-surface + consent tests.

Every verb is exercised through a recording capture-only adapter (it does NOT subclass
``AnalyticsAdapter`` — the bar-A structural-conformance posture). The tests pin the minted
event shape (``internal_kind``, ``distinct_id``, the nested trait wrappers), the
super-properties merge (capture only), and the instance-level consent switch.
"""

from __future__ import annotations

from analytics_kit import (
    Analytics,
    AnalyticsAdapter,
    ConsentState,
    NeutralEvent,
    NeutralProperties,
    NeutralResponse,
)


class _RecordingAdapter:
    """Capture-only adapter that records every minted event and lifecycle call."""

    def __init__(self) -> None:
        self.captured: list[NeutralEvent] = []
        self.flushed = 0
        self.shut_down = 0
        self._consent: ConsentState = "granted"

    def capture(self, event: NeutralEvent) -> None:
        self.captured.append(event)

    def flush(self) -> None:
        self.flushed += 1

    def shutdown(self) -> None:
        self.shut_down += 1

    def send(
        self,
        url: str,
        method: str,
        headers: dict[str, str],
        body: str | None = None,
    ) -> NeutralResponse:
        return NeutralResponse(status=200, body="")

    def get_consent_state(self) -> ConsentState:
        return self._consent

    def set_consent_state(self, state: ConsentState) -> None:
        self._consent = state

    def get_library_id(self) -> str:
        return "analytics-kit"

    def get_library_version(self) -> str:
        return "0.0.0"


def _conforms(adapter: AnalyticsAdapter) -> None:
    """The recording adapter satisfies the SPI structurally (mypy-level bar-A proof)."""


def test_recording_adapter_conforms() -> None:
    adapter = _RecordingAdapter()
    _conforms(adapter)
    assert AnalyticsAdapter not in type(adapter).__mro__


# --- capture ---------------------------------------------------------------------------


def test_capture_mints_a_plain_event() -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(adapter)

    provider.capture("u1", "signed_up", {"plan": "pro"})

    assert len(adapter.captured) == 1
    event = adapter.captured[0]
    assert event.event == "signed_up"
    assert event.distinct_id == "u1"
    assert event.properties == {"plan": "pro"}
    assert event.internal_kind is None
    assert event.dedupe_id != ""
    assert event.timestamp is not None


def test_capture_distinct_id_is_first_positional() -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(adapter)

    provider.capture("u9", "opened_app")

    assert adapter.captured[0].distinct_id == "u9"
    assert adapter.captured[0].event == "opened_app"


def test_capture_uses_supplied_dedupe_id() -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(adapter)

    provider.capture("u1", "signed_up", dedupe_id="fixed-id")

    assert adapter.captured[0].dedupe_id == "fixed-id"


def test_capture_mints_dedupe_id_when_absent() -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(adapter)

    provider.capture("u1", "e1")
    provider.capture("u1", "e2")

    ids = {e.dedupe_id for e in adapter.captured}
    assert len(ids) == 2  # each mint is unique
    assert all(len(i) > 0 for i in ids)


def test_capture_with_no_properties_and_no_super_properties_is_none() -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(adapter)

    provider.capture("u1", "opened_app")

    assert adapter.captured[0].properties is None


# --- set -------------------------------------------------------------------------------


def test_set_once_false_nests_under_set() -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(adapter)

    provider.set("u1", {"plan": "pro"})

    event = adapter.captured[0]
    assert event.event == "set_traits"
    assert event.internal_kind == "set_traits"
    assert event.distinct_id == "u1"
    assert event.properties == {"set": {"plan": "pro"}}


def test_set_once_true_nests_under_set_once() -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(adapter)

    provider.set("u1", {"first_seen": "2026-07-09"}, once=True)

    event = adapter.captured[0]
    assert event.event == "set_traits"
    assert event.internal_kind == "set_traits"
    assert event.properties == {"set_once": {"first_seen": "2026-07-09"}}


def test_set_keys_are_never_dollar_prefixed() -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(adapter)

    provider.set("u1", {"a": 1})
    provider.set("u2", {"b": 2}, once=True)

    for event in adapter.captured:
        assert event.properties is not None
        assert all(not k.startswith("$") for k in event.properties)


# --- set_group_traits ------------------------------------------------------------------


def test_set_group_traits_wrapper_and_composite_distinct_id() -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(adapter)

    provider.set_group_traits("company", "acme", {"tier": "enterprise"})

    event = adapter.captured[0]
    assert event.event == "set_group_traits"
    assert event.internal_kind == "set_group_traits"
    assert event.distinct_id == "company_acme"
    assert event.properties == {
        "group_type": "company",
        "group_key": "acme",
        "group_set": {"tier": "enterprise"},
    }


def test_group_keys_are_never_dollar_prefixed() -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(adapter)

    provider.set_group_traits("company", "acme", {"tier": "enterprise"})

    event = adapter.captured[0]
    assert event.properties is not None
    assert all(not k.startswith("$") for k in event.properties)


# --- super_properties ------------------------------------------------------------------


def test_super_properties_merge_into_capture() -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(adapter, super_properties={"app_version": "1.2.3"})

    provider.capture("u1", "signed_up", {"plan": "pro"})

    assert adapter.captured[0].properties == {"app_version": "1.2.3", "plan": "pro"}


def test_super_properties_merge_when_capture_has_no_properties() -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(adapter, super_properties={"app_version": "1.2.3"})

    provider.capture("u1", "opened_app")

    assert adapter.captured[0].properties == {"app_version": "1.2.3"}


def test_capture_properties_override_super_properties_on_collision() -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(adapter, super_properties={"plan": "free"})

    provider.capture("u1", "signed_up", {"plan": "pro"})

    assert adapter.captured[0].properties == {"plan": "pro"}


def test_super_properties_not_merged_into_set() -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(adapter, super_properties={"app_version": "1.2.3"})

    provider.set("u1", {"plan": "pro"})

    assert adapter.captured[0].properties == {"set": {"plan": "pro"}}


def test_super_properties_not_merged_into_set_group_traits() -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(adapter, super_properties={"app_version": "1.2.3"})

    provider.set_group_traits("company", "acme", {"tier": "enterprise"})

    assert adapter.captured[0].properties == {
        "group_type": "company",
        "group_key": "acme",
        "group_set": {"tier": "enterprise"},
    }


def test_super_properties_are_not_mutated_by_capture() -> None:
    supers: NeutralProperties = {"app_version": "1.2.3"}
    adapter = _RecordingAdapter()
    provider = Analytics(adapter, super_properties=supers)

    provider.capture("u1", "signed_up", {"plan": "pro"})

    assert supers == {"app_version": "1.2.3"}


# --- consent ---------------------------------------------------------------------------


def test_opt_out_drops_capture_set_and_group() -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(adapter)

    provider.opt_out()
    provider.capture("u1", "signed_up")
    provider.set("u1", {"plan": "pro"})
    provider.set_group_traits("company", "acme", {"tier": "enterprise"})

    assert adapter.captured == []


def test_has_opted_out_reflects_switch() -> None:
    provider = Analytics(_RecordingAdapter())

    assert provider.has_opted_out() is False
    provider.opt_out()
    assert provider.has_opted_out() is True
    provider.opt_in()
    assert provider.has_opted_out() is False


def test_opt_in_restores_delivery() -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(adapter)

    provider.opt_out()
    provider.capture("u1", "dropped")
    provider.opt_in()
    provider.capture("u1", "delivered")

    assert len(adapter.captured) == 1
    assert adapter.captured[0].event == "delivered"


# --- lifecycle -------------------------------------------------------------------------


def test_flush_delegates_to_adapter() -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(adapter)

    provider.flush()

    assert adapter.flushed == 1


def test_shutdown_delegates_to_adapter() -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(adapter)

    provider.shutdown()

    assert adapter.shut_down == 1


# --- capability slots + N-A verbs ------------------------------------------------------


def test_flags_and_replay_default_to_none() -> None:
    provider = Analytics(_RecordingAdapter())

    assert provider.flags is None
    assert provider.replay is None


def test_provider_has_no_browser_only_verbs() -> None:
    provider = Analytics(_RecordingAdapter())

    assert not hasattr(provider, "page")
    assert not hasattr(provider, "reset")
    assert not hasattr(provider, "register")
    assert not hasattr(provider, "unregister")


def test_provider_exposes_server_shaped_surface() -> None:
    provider = Analytics(_RecordingAdapter())

    for verb in (
        "capture",
        "set",
        "set_group_traits",
        "flush",
        "shutdown",
        "opt_in",
        "opt_out",
        "has_opted_out",
    ):
        assert callable(getattr(provider, verb))


def test_analytics_importable_from_client_entry() -> None:
    from analytics_kit.client import Analytics as ClientAnalytics

    assert ClientAnalytics is Analytics
