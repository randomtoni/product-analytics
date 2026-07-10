"""E12-S1 substrate tests for the Python feature-flag port, empty snapshot, taxonomy slot, and
the ``flags.bootstrap`` config field.

These pin the parity mirror of the TS ``FeatureFlagPort`` / ``FlagSet`` / ``emptyFlagSet`` and the
taxonomy ``flags`` slot + ``flags.bootstrap`` config shape. The load-bearing assertion is that
``evaluate`` is **synchronous by design** — a bare ``FlagSet`` return, NOT a coroutine (the PY5
no-asyncio precedent). This test states that explicitly so a future reader does not "fix" it toward
asyncio: ``ports.py`` is deliberately outside ``test_sync_seam.py``'s seam fence, so a sync
``evaluate`` there trips nothing — this file is where the intent is recorded.
"""

from __future__ import annotations

import inspect

import pytest
from pydantic import ValidationError

from analytics_kit import (
    Analytics,
    AnalyticsConfig,
    FeatureFlagPort,
    FlagBootstrap,
    FlagsConfig,
    FlagSet,
    NoopAdapter,
    Taxonomy,
    define_taxonomy,
    derive_allowlist_from_taxonomy,
    empty_flag_set,
)


# --- port surface + sync-by-design ---------------------------------------------------------------


def test_feature_flag_port_exposes_exactly_evaluate_and_on_change() -> None:
    members = {name for name in vars(FeatureFlagPort) if not name.startswith("_")}
    assert members == {"evaluate", "on_change"}


def test_evaluate_is_synchronous_not_a_coroutine_by_design() -> None:
    # The load-bearing parity call: evaluate returns a BARE FlagSet, never a coroutine. A future
    # reader must NOT "fix" this toward asyncio — the blocking round-trip lives in the S4 adapter.
    assert not inspect.iscoroutinefunction(FeatureFlagPort.evaluate)


def test_on_change_is_synchronous_not_a_coroutine() -> None:
    assert not inspect.iscoroutinefunction(FeatureFlagPort.on_change)


def test_flag_set_exposes_the_neutral_read_surface_plus_degradation_signal() -> None:
    members = {name for name in vars(FlagSet) if not name.startswith("_")}
    assert members == {"is_enabled", "get_flag", "get_payload", "get_all", "degraded", "reason"}


def test_provider_flags_slot_is_retyped_to_the_real_port_and_stays_none_default() -> None:
    # The slot is annotated FeatureFlagPort | None and stays None-default (no adapter wired here).
    # provider.py uses `from __future__ import annotations`, so the annotation is stored as its
    # source string.
    assert Analytics.__annotations__["flags"] == "FeatureFlagPort | None"
    provider = Analytics(NoopAdapter())
    assert provider.flags is None


# --- empty_flag_set: the canonical nothing-resolved snapshot -------------------------------------


def test_empty_flag_set_every_read_is_callable_without_raising() -> None:
    snapshot = empty_flag_set()

    assert snapshot.is_enabled("anything") is False
    assert snapshot.get_flag("anything") is None
    assert snapshot.get_payload("anything") is None
    assert snapshot.get_all() == {}
    assert snapshot.degraded is True
    assert snapshot.reason("anything") == "unresolved"


def test_empty_flag_set_is_immutable() -> None:
    snapshot = empty_flag_set()
    with pytest.raises(AttributeError):
        snapshot.degraded = False  # type: ignore[misc]


def test_empty_flag_set_conforms_structurally_to_the_port_flag_set() -> None:
    # Bar-A proof at the type level: mypy accepts the empty snapshot as a FlagSet.
    snapshot: FlagSet = empty_flag_set()
    assert snapshot.reason("k") == "unresolved"


# --- taxonomy flags slot -------------------------------------------------------------------------


def test_taxonomy_flags_slot_is_walkable_in_the_runtime_registry() -> None:
    tax = define_taxonomy(
        {
            "events": {"e": {}},
            "flags": {
                "checkout_variant": {"variants": ["a", "b"], "payload": {"discount": "number"}},
                "dark_mode": {},
            },
        }
    )

    assert isinstance(tax, Taxonomy)
    flags = tax.decl["flags"]
    assert set(flags) == {"checkout_variant", "dark_mode"}
    assert flags["checkout_variant"]["variants"] == ["a", "b"]
    assert flags["checkout_variant"]["payload"] == {"discount": "number"}
    assert flags["dark_mode"] == {}


def test_flag_payloads_are_not_derived_into_the_allowlist() -> None:
    # Flag payloads are inbound (server → client), NOT consumer-supplied outbound props, so the
    # derive helper has no flags branch — a payload prop key must NOT leak into the allowlist.
    tax = define_taxonomy(
        {
            "events": {"signed_up": {"plan": "string"}},
            "flags": {"checkout_variant": {"payload": {"discount": "number"}}},
        }
    )

    allowlist = derive_allowlist_from_taxonomy(tax)
    assert "plan" in allowlist
    assert "discount" not in allowlist


# --- flags.bootstrap config field ----------------------------------------------------------------


def test_config_accepts_flags_bootstrap_with_neutral_field_names() -> None:
    config = AnalyticsConfig(
        flags=FlagsConfig(
            bootstrap=FlagBootstrap(
                flags={"dark_mode": True, "checkout_variant": "a"},
                payloads={"checkout_variant": {"discount": 10}},
            )
        )
    )

    assert config.flags is not None
    assert config.flags.bootstrap is not None
    assert config.flags.bootstrap.flags == {"dark_mode": True, "checkout_variant": "a"}
    assert config.flags.bootstrap.payloads == {"checkout_variant": {"discount": 10}}


def test_config_flags_defaults_to_none() -> None:
    assert AnalyticsConfig().flags is None


def test_config_parses_flags_bootstrap_from_a_plain_dict() -> None:
    config = AnalyticsConfig.model_validate(
        {"flags": {"bootstrap": {"flags": {"dark_mode": False}}}}
    )
    assert config.flags is not None
    assert config.flags.bootstrap is not None
    assert config.flags.bootstrap.flags == {"dark_mode": False}


def test_typoed_bootstrap_sub_key_is_rejected_loudly() -> None:
    # extra="forbid" on the nested models must bite: a typo'd sub-key raises, never silently drops.
    with pytest.raises(ValidationError):
        AnalyticsConfig.model_validate(
            {"flags": {"bootstrap": {"featureFlags": {"dark_mode": True}}}}
        )


def test_typoed_flags_sub_key_is_rejected_loudly() -> None:
    with pytest.raises(ValidationError):
        AnalyticsConfig.model_validate({"flags": {"bootstrapp": {"flags": {}}}})


def test_no_vendor_prefixed_field_names_on_the_bootstrap_shape() -> None:
    fields = set(FlagBootstrap.model_fields)
    assert fields == {"flags", "payloads"}
    assert not any(name.startswith("feature_flag") for name in fields)
