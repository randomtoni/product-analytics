"""Config-parse boundary, the config-selected factory, and the whole-stack no-op.

The factory is bar B ("new-app adoption = config only, zero library change") made real: a
consumer obtains a working (silent) provider by configuration alone. The tests pin the
Pydantic validation of the one inbound boundary, the supplied-vs-``None`` adapter selection,
the ``super_properties`` config→provider wiring, and the full-SPI silence of ``NoopAdapter``.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from analytics_kit import (
    AnalyticsAdapter,
    AnalyticsConfig,
    ConsentState,
    NeutralEvent,
    NeutralResponse,
    NoopAdapter,
    create_analytics,
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
    """Structural-conformance sink — mypy proves satisfaction without inheritance."""


# --- AnalyticsConfig (the one inbound boundary) ----------------------------------------


def test_config_is_pydantic_model() -> None:
    from pydantic import BaseModel

    assert issubclass(AnalyticsConfig, BaseModel)


def test_config_defaults_are_none() -> None:
    config = AnalyticsConfig()

    assert config.key is None
    assert config.super_properties is None


def test_config_accepts_key_and_super_properties() -> None:
    config = AnalyticsConfig(key="k1", super_properties={"app_version": "1.2.3"})

    assert config.key == "k1"
    assert config.super_properties == {"app_version": "1.2.3"}


def test_config_rejects_wrong_key_type() -> None:
    with pytest.raises(ValidationError):
        AnalyticsConfig(key=123)  # type: ignore[arg-type]


def test_config_rejects_wrong_super_properties_type() -> None:
    with pytest.raises(ValidationError):
        AnalyticsConfig(super_properties="not-a-dict")  # type: ignore[arg-type]


def test_config_rejects_unknown_key() -> None:
    # A typo (super_props vs super_properties) raises loudly, never silently degrades.
    with pytest.raises(ValidationError):
        AnalyticsConfig(super_props={"app_version": "1.2.3"})  # type: ignore[call-arg]


def test_factory_rejects_unknown_key_in_dict_config() -> None:
    with pytest.raises(ValidationError):
        create_analytics({"super_props": {"app_version": "1.2.3"}})


# --- NoopAdapter (full SPI, whole-stack silence) ---------------------------------------


def test_noop_adapter_conforms_to_spi() -> None:
    adapter = NoopAdapter()
    _conforms(adapter)
    assert AnalyticsAdapter not in type(adapter).__mro__


def test_noop_capture_is_silent() -> None:
    adapter = NoopAdapter()

    adapter.capture(
        NeutralEvent(event="signed_up", distinct_id="u1", dedupe_id="d1")
    )  # no observable effect


def test_noop_lifecycle_returns() -> None:
    adapter = NoopAdapter()

    adapter.flush()  # returns, no observable effect
    adapter.shutdown()


def test_noop_send_returns_empty_response_never_none() -> None:
    adapter = NoopAdapter()

    response = adapter.send("https://example.invalid", "POST", {}, "{}")

    assert isinstance(response, NeutralResponse)
    assert response.status == 0
    assert response.body == ""


def test_noop_consent_is_denied() -> None:
    adapter = NoopAdapter()

    assert adapter.get_consent_state() == "denied"
    adapter.set_consent_state("granted")
    assert adapter.get_consent_state() == "denied"  # set is a no-op


def test_noop_identity_getters_are_neutral_placeholders() -> None:
    adapter = NoopAdapter()

    assert adapter.get_library_id() == "analytics-kit"
    assert adapter.get_library_version() == "0.0.0"
    assert "posthog" not in adapter.get_library_id().lower()
    assert "posthog" not in adapter.get_library_version().lower()


# --- create_analytics (config-selected factory) ----------------------------------------


def test_factory_unkeyed_returns_silent_provider() -> None:
    provider = create_analytics(AnalyticsConfig())

    # Bar B: a working (silent) provider by config alone; captures reach the wire nowhere.
    provider.capture("u1", "signed_up", {"plan": "pro"})
    provider.set("u1", {"plan": "pro"})
    provider.set_group_traits("company", "acme", {"tier": "enterprise"})
    provider.flush()
    provider.shutdown()


def test_factory_returns_provider_instance() -> None:
    from analytics_kit import Analytics

    provider = create_analytics(AnalyticsConfig())

    assert isinstance(provider, Analytics)


def test_factory_delegates_to_supplied_adapter() -> None:
    adapter = _RecordingAdapter()

    provider = create_analytics(AnalyticsConfig(), adapter)
    provider.capture("u1", "signed_up", {"plan": "pro"})

    assert len(adapter.captured) == 1
    assert adapter.captured[0].event == "signed_up"
    assert adapter.captured[0].distinct_id == "u1"


def test_factory_selection_is_supplied_vs_none_not_type_based() -> None:
    adapter = _RecordingAdapter()

    # A supplied adapter is used verbatim (identity), never swapped for the noop.
    provider = create_analytics(AnalyticsConfig(), adapter)
    provider.flush()

    assert adapter.flushed == 1


def test_factory_threads_super_properties_into_provider() -> None:
    adapter = _RecordingAdapter()
    config = AnalyticsConfig(super_properties={"app_version": "1.2.3"})

    provider = create_analytics(config, adapter)
    provider.capture("u1", "signed_up", {"plan": "pro"})

    assert adapter.captured[0].properties == {"app_version": "1.2.3", "plan": "pro"}


def test_factory_no_super_properties_leaves_capture_properties_unchanged() -> None:
    adapter = _RecordingAdapter()

    provider = create_analytics(AnalyticsConfig(), adapter)
    provider.capture("u1", "signed_up", {"plan": "pro"})

    assert adapter.captured[0].properties == {"plan": "pro"}


def test_factory_validates_config_and_raises_on_bad_input() -> None:
    with pytest.raises(ValidationError):
        create_analytics({"key": 123})


def test_factory_accepts_a_dict_config() -> None:
    adapter = _RecordingAdapter()

    provider = create_analytics({"super_properties": {"app_version": "1.2.3"}}, adapter)
    provider.capture("u1", "signed_up")

    assert adapter.captured[0].properties == {"app_version": "1.2.3"}


def test_no_disabled_flag_threaded_through_provider() -> None:
    provider = create_analytics(AnalyticsConfig())

    assert not hasattr(provider, "disabled")
    assert not hasattr(provider, "_disabled")
