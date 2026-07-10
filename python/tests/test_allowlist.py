"""Payload-allowlist tests — the standalone guard + its provider call-boundary wiring.

The standalone tests pin ``enforce_allowlist`` semantics ported 1:1 from the TypeScript
``enforceAllowlist``: ``None``-inactive vs. empty-set-active, keys-only, both policies, the
multi-bag short-circuit, the ``None``-bag skip, and the exact message. The provider tests pin
where the gate sits — after the opt-out early-return, before minting — gating the merged
super-props on ``capture`` and the inner traits on ``set``/``set_group_traits``, never the
routing identifiers or the library-computed wrapper keys. A rejected event never reaches the
recording adapter.
"""

from __future__ import annotations

import logging

import pytest

from analytics_kit import (
    Analytics,
    AnalyticsConfig,
    ConsentState,
    NeutralEvent,
    NeutralResponse,
    create_analytics,
    enforce_allowlist,
)

_LOGGER_NAME = "analytics_kit"


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


# --- enforce_allowlist: standalone semantics -------------------------------------------


def test_enforce_allowlist_is_a_plain_function_callable_standalone() -> None:
    # not a Pydantic model/validator — a pure function, no provider needed
    assert enforce_allowlist(frozenset({"plan"}), "throw", {"plan": "pro"}) is True


def test_none_allowlist_is_inactive_every_key_passes() -> None:
    assert enforce_allowlist(None, "throw", {"any_key": 1, "another": 2}) is True


def test_empty_frozenset_activates_allow_nothing() -> None:
    # activation predicate is `allowlist is not None`, NOT len > 0
    with pytest.raises(ValueError, match="any_key"):
        enforce_allowlist(frozenset(), "throw", {"any_key": 1})


def test_throw_policy_raises_exact_message_naming_key() -> None:
    with pytest.raises(
        ValueError,
        match=r'analytics-kit: property "ssn" is not on the payload allowlist',
    ):
        enforce_allowlist(frozenset({"plan"}), "throw", {"ssn": "123"})


def test_drop_and_error_log_logs_once_and_returns_false(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.ERROR, logger=_LOGGER_NAME):
        result = enforce_allowlist(frozenset({"plan"}), "drop-and-error-log", {"ssn": "123"})

    assert result is False
    records = [r for r in caplog.records if r.name == _LOGGER_NAME]
    assert len(records) == 1
    assert records[0].levelno == logging.ERROR
    assert records[0].getMessage() == (
        'analytics-kit: property "ssn" is not on the payload allowlist'
    )


def test_all_on_list_returns_true_and_does_not_log(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.ERROR, logger=_LOGGER_NAME):
        result = enforce_allowlist(
            frozenset({"plan", "seats"}), "drop-and-error-log", {"plan": "pro", "seats": 3}
        )

    assert result is True
    assert [r for r in caplog.records if r.name == _LOGGER_NAME] == []


def test_multi_bag_catches_off_list_key_in_second_bag() -> None:
    with pytest.raises(ValueError, match="first_seen"):
        enforce_allowlist(frozenset({"plan"}), "throw", {"plan": "pro"}, {"first_seen": 1})


def test_multi_bag_short_circuits_on_first_off_list_key(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.ERROR, logger=_LOGGER_NAME):
        result = enforce_allowlist(
            frozenset({"plan"}),
            "drop-and-error-log",
            {"plan": "pro", "ssn": "123"},
            {"plan": "free"},
        )

    assert result is False
    records = [r for r in caplog.records if r.name == _LOGGER_NAME]
    assert len(records) == 1  # loop stops at the first off-list key
    assert "ssn" in records[0].getMessage()


def test_none_bag_is_skipped() -> None:
    assert enforce_allowlist(frozenset({"plan"}), "throw", None, {"plan": "pro"}) is True
    assert enforce_allowlist(frozenset({"plan"}), "throw", {"plan": "pro"}, None) is True


def test_no_bags_is_trivially_allowed() -> None:
    assert enforce_allowlist(frozenset({"plan"}), "throw") is True


def test_inspects_keys_only_never_values() -> None:
    allowlist = frozenset({"plan"})
    # same key, wildly different values — all pass, only the key is checked
    assert enforce_allowlist(allowlist, "throw", {"plan": "pro"}) is True
    assert enforce_allowlist(allowlist, "throw", {"plan": None}) is True
    assert enforce_allowlist(allowlist, "throw", {"plan": {"nested": "secret"}}) is True
    # an off-list key fails regardless of its (harmless-looking) value
    with pytest.raises(ValueError, match="ssn"):
        enforce_allowlist(allowlist, "throw", {"ssn": None})


# --- AnalyticsConfig: additive fields --------------------------------------------------


def test_config_defaults_allowlist_none_and_on_violation_throw() -> None:
    config = AnalyticsConfig()

    assert config.allowlist is None
    assert config.on_violation == "throw"


def test_config_accepts_allowlist_and_on_violation() -> None:
    config = AnalyticsConfig(allowlist=["plan"], on_violation="drop-and-error-log")

    assert config.allowlist == ["plan"]
    assert config.on_violation == "drop-and-error-log"


def test_config_rejects_unknown_on_violation_value() -> None:
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        AnalyticsConfig(on_violation="silently-drop")  # type: ignore[arg-type]


def test_config_empty_allowlist_is_present_not_none() -> None:
    # an explicit empty list survives as [] (present-but-empty ⇒ active downstream)
    config = AnalyticsConfig(allowlist=[])

    assert config.allowlist == []


# --- provider gating: inactive-by-default ----------------------------------------------


def test_direct_construction_without_allowlist_is_inactive() -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(adapter)  # Analytics(adapter) stays valid, guard inactive

    provider.capture("u1", "signed_up", {"anything": 1})
    provider.set("u1", {"whatever": 2})
    provider.set_group_traits("company", "acme", {"unlisted": 3})

    assert len(adapter.captured) == 3


# --- provider gating: capture (merged super-props) -------------------------------------


def test_capture_gates_merged_bag_off_list_key_throws() -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(adapter, allowlist=frozenset({"plan"}), on_violation="throw")

    with pytest.raises(ValueError, match="secret"):
        provider.capture("u1", "signed_up", {"plan": "pro", "secret": 1})

    assert adapter.captured == []  # never minted


def test_capture_on_list_key_passes() -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(adapter, allowlist=frozenset({"plan"}), on_violation="throw")

    provider.capture("u1", "signed_up", {"plan": "pro"})

    assert len(adapter.captured) == 1
    assert adapter.captured[0].properties == {"plan": "pro"}


def test_capture_does_not_gate_distinct_id_or_event_name() -> None:
    adapter = _RecordingAdapter()
    # distinct_id / event carry values that are NOT on the allowlist — they are routing, not props
    provider = Analytics(adapter, allowlist=frozenset({"plan"}), on_violation="throw")

    provider.capture("some_off_list_user", "some_off_list_event", {"plan": "pro"})

    assert len(adapter.captured) == 1
    assert adapter.captured[0].distinct_id == "some_off_list_user"
    assert adapter.captured[0].event == "some_off_list_event"


def test_capture_super_prop_only_off_list_key_is_gated_when_properties_none() -> None:
    # the merged bag carries the super-prop even when `properties is None`
    adapter = _RecordingAdapter()
    provider = Analytics(
        adapter,
        super_properties={"secret": 1},
        allowlist=frozenset({"plan"}),
        on_violation="throw",
    )

    with pytest.raises(ValueError, match="secret"):
        provider.capture("u1", "signed_up", {"plan": "pro"})

    assert adapter.captured == []


def test_capture_super_prop_on_list_passes_when_properties_supplies_none() -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(
        adapter,
        super_properties={"app_version": "1.2.3"},
        allowlist=frozenset({"app_version"}),
        on_violation="throw",
    )

    provider.capture("u1", "opened_app")

    assert len(adapter.captured) == 1
    assert adapter.captured[0].properties == {"app_version": "1.2.3"}


def test_capture_drop_policy_logs_once_and_never_mints(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(
        adapter, allowlist=frozenset({"plan"}), on_violation="drop-and-error-log"
    )

    with caplog.at_level(logging.ERROR, logger=_LOGGER_NAME):
        provider.capture("u1", "signed_up", {"secret": 1})  # early-return, no mint

    assert adapter.captured == []
    assert len([r for r in caplog.records if r.name == _LOGGER_NAME]) == 1


# --- provider gating: set (inner traits, before nesting) -------------------------------


def test_set_gates_inner_traits_before_nesting_throw() -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(adapter, allowlist=frozenset({"plan"}), on_violation="throw")

    with pytest.raises(ValueError, match="role"):
        provider.set("u1", {"plan": "pro", "role": "admin"})

    assert adapter.captured == []


def test_set_does_not_gate_the_wrapper_key() -> None:
    # 'set' / 'set_once' are library-computed wrapper keys, NOT on the allowlist, yet pass
    adapter = _RecordingAdapter()
    provider = Analytics(adapter, allowlist=frozenset({"plan"}), on_violation="throw")

    provider.set("u1", {"plan": "pro"})
    provider.set("u1", {"plan": "free"}, once=True)

    assert len(adapter.captured) == 2
    assert adapter.captured[0].properties == {"set": {"plan": "pro"}}
    assert adapter.captured[1].properties == {"set_once": {"plan": "free"}}


def test_set_drop_policy_logs_once_and_never_mints(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(
        adapter, allowlist=frozenset({"plan"}), on_violation="drop-and-error-log"
    )

    with caplog.at_level(logging.ERROR, logger=_LOGGER_NAME):
        provider.set("u1", {"role": "admin"})  # early-return, no mint

    assert adapter.captured == []
    assert len([r for r in caplog.records if r.name == _LOGGER_NAME]) == 1


# --- provider gating: set_group_traits (inner traits, routing keys NOT gated) ----------


def test_set_group_traits_gates_inner_traits_throw() -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(adapter, allowlist=frozenset({"tier"}), on_violation="throw")

    with pytest.raises(ValueError, match="seats"):
        provider.set_group_traits("company", "acme", {"tier": "enterprise", "seats": 3})

    assert adapter.captured == []


def test_set_group_traits_does_not_gate_routing_or_wrapper_keys() -> None:
    # group_type/group_key are routing; group_set is a library-computed wrapper key — none gated
    adapter = _RecordingAdapter()
    provider = Analytics(adapter, allowlist=frozenset({"tier"}), on_violation="throw")

    provider.set_group_traits("company", "acme", {"tier": "enterprise"})

    assert len(adapter.captured) == 1
    assert adapter.captured[0].properties == {
        "group_type": "company",
        "group_key": "acme",
        "group_set": {"tier": "enterprise"},
    }


def test_set_group_traits_drop_policy_logs_once_and_never_mints(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(
        adapter, allowlist=frozenset({"tier"}), on_violation="drop-and-error-log"
    )

    with caplog.at_level(logging.ERROR, logger=_LOGGER_NAME):
        provider.set_group_traits("company", "acme", {"seats": 3})  # early-return, no mint

    assert adapter.captured == []
    assert len([r for r in caplog.records if r.name == _LOGGER_NAME]) == 1


# --- factory wiring --------------------------------------------------------------------


def test_factory_threads_allowlist_and_policy_into_provider() -> None:
    adapter = _RecordingAdapter()
    config = AnalyticsConfig(allowlist=["plan"], on_violation="throw")

    provider = create_analytics(config, adapter)

    with pytest.raises(ValueError, match="secret"):
        provider.capture("u1", "signed_up", {"secret": 1})
    assert adapter.captured == []

    provider.capture("u1", "signed_up", {"plan": "pro"})
    assert len(adapter.captured) == 1


def test_factory_no_allowlist_leaves_guard_inactive() -> None:
    adapter = _RecordingAdapter()

    provider = create_analytics(AnalyticsConfig(), adapter)
    provider.capture("u1", "signed_up", {"anything": 1})

    assert len(adapter.captured) == 1


def test_factory_empty_allowlist_activates_allow_nothing() -> None:
    # [] resolves to frozenset() which is ACTIVE — every consumer key fails
    adapter = _RecordingAdapter()
    config = AnalyticsConfig(allowlist=[], on_violation="throw")

    provider = create_analytics(config, adapter)

    with pytest.raises(ValueError, match="anything"):
        provider.capture("u1", "signed_up", {"anything": 1})
    assert adapter.captured == []


def test_factory_drop_policy_from_config(caplog: pytest.LogCaptureFixture) -> None:
    adapter = _RecordingAdapter()
    config = AnalyticsConfig(allowlist=["plan"], on_violation="drop-and-error-log")

    provider = create_analytics(config, adapter)
    with caplog.at_level(logging.ERROR, logger=_LOGGER_NAME):
        provider.capture("u1", "signed_up", {"secret": 1})

    assert adapter.captured == []
    assert len([r for r in caplog.records if r.name == _LOGGER_NAME]) == 1


# --- consent-ordering interaction ------------------------------------------------------


def test_opt_out_short_circuits_before_the_allowlist_guard() -> None:
    # opt-out early-returns first: an off-list key does NOT raise while opted out
    adapter = _RecordingAdapter()
    provider = Analytics(adapter, allowlist=frozenset({"plan"}), on_violation="throw")

    provider.opt_out()
    provider.capture("u1", "signed_up", {"secret": 1})  # no raise — dropped by consent

    assert adapter.captured == []
