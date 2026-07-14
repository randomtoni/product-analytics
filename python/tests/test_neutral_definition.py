"""E20-S1 — the neutral definition type + pure lowering + seed-time validator (Python server).

The load-bearing proof: a representative neutral definition set lowered through ``lower_definitions``
evaluates IDENTICALLY (same ``FlagValue``, same resolved payload) to the equivalent flags loaded via
the poller path — the wire fixtures below are the values-known-correct external contract the poller's
``_parse_definitions`` builds (mirrors ``test_flag_parity.py``: ``filters.groups`` /
``filters.multivariate.variants`` / ``filters.payloads``, keyed by stringified ``true`` / variant-key,
NEVER a ``false`` key).
"""

from __future__ import annotations

import json
from typing import Any, cast

import pytest
from pydantic import ValidationError

from analytics_kit import (
    FeatureFlagDefinition,
    FlagContext,
)
from analytics_kit.flags.local.definition_types import DefinitionSnapshot
from analytics_kit.flags.local.evaluator import compute_flag_locally
from analytics_kit.flags.local.neutral_definition import (
    lower_definitions,
    validate_definitions,
)


def _d(value: object) -> dict[str, Any]:
    """Narrow an untyped wire value (the snapshot's ``dict[str, object]`` flags) to an indexable dict
    for introspection in the shape assertions — the wire types are deliberately untyped JSON dicts."""
    return cast("dict[str, Any]", value)


def _malformed(*definitions: dict[str, Any]) -> list[FeatureFlagDefinition]:
    """Build a deliberately-malformed definition set for the reject-list tests. The values are
    runtime-invalid on purpose (an operator outside the union, an out-of-range rollout), so they are
    typed loosely and cast — the validator must reject them at runtime, which is what these assert."""
    return cast("list[FeatureFlagDefinition]", list(definitions))

# ---------------------------------------------------------------------------------------------
# The representative neutral set: boolean, multivariate, a condition with property filters + rollout +
# variant override, and payloads.
# ---------------------------------------------------------------------------------------------


def _simple() -> FeatureFlagDefinition:
    return {
        "key": "simple-flag",
        "enabled": True,
        "conditions": [{"property_filters": [], "rollout_percentage": 100}],
        "payloads": {"true": json.dumps({"via": "defn"})},
    }


def _multivariate() -> FeatureFlagDefinition:
    return {
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


def _prop_gated() -> FeatureFlagDefinition:
    return {
        "key": "prop-flag",
        "enabled": True,
        "conditions": [
            {"property_filters": [{"property": "plan", "operator": "exact", "value": "pro"}], "rollout_percentage": 100}
        ],
    }


def _override() -> FeatureFlagDefinition:
    return {
        "key": "override-flag",
        "enabled": True,
        "conditions": [{"property_filters": [], "rollout_percentage": 100, "variant_override": "third-variant"}],
        "variants": [
            {"key": "first-variant", "rollout_percentage": 50},
            {"key": "second-variant", "rollout_percentage": 25},
            {"key": "third-variant", "rollout_percentage": 25},
        ],
    }


def _disabled() -> FeatureFlagDefinition:
    return {
        "key": "disabled-flag",
        "enabled": False,
        "conditions": [{"property_filters": [], "rollout_percentage": 100}],
    }


def _neutral_set() -> list[FeatureFlagDefinition]:
    return [_simple(), _multivariate(), _prop_gated(), _override(), _disabled()]


# The equivalent WIRE definitions the poller would fetch — the values-known-correct external contract
# (NOT derived from the lowering). The parity proof asserts the LOWERED snapshot evaluates identically
# to a snapshot built from THESE.
def _wire_set() -> list[dict[str, Any]]:
    return [
        {
            "key": "simple-flag",
            "active": True,
            "filters": {
                "groups": [{"properties": [], "rollout_percentage": 100}],
                "payloads": {"true": json.dumps({"via": "defn"})},
            },
        },
        {
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
        },
        {
            "key": "prop-flag",
            "active": True,
            "filters": {
                "groups": [{"properties": [{"key": "plan", "operator": "exact", "value": "pro"}], "rollout_percentage": 100}]
            },
        },
        {
            "key": "override-flag",
            "active": True,
            "filters": {
                "groups": [{"properties": [], "rollout_percentage": 100, "variant": "third-variant"}],
                "multivariate": {
                    "variants": [
                        {"key": "first-variant", "rollout_percentage": 50},
                        {"key": "second-variant", "rollout_percentage": 25},
                        {"key": "third-variant", "rollout_percentage": 25},
                    ]
                },
            },
        },
        {
            "key": "disabled-flag",
            "active": False,
            "filters": {"groups": [{"properties": [], "rollout_percentage": 100}]},
        },
    ]


def _poller_snapshot(flags: list[dict[str, Any]]) -> DefinitionSnapshot:
    """Build the exact snapshot shape the poller's ``_parse_definitions`` produces from a fetched
    flag list."""
    return DefinitionSnapshot(
        flags=tuple(flags),
        flags_by_key={str(flag["key"]): flag for flag in flags},
        group_type_mapping={},
        cohorts={},
    )


_CONTEXT: FlagContext = {"distinct_id": "distinct_id_0", "person_properties": {"plan": "pro"}}


# ---------------------------------------------------------------------------------------------
# Lowering shape.
# ---------------------------------------------------------------------------------------------


def test_lowering_produces_complete_snapshot_keeping_disabled_flags() -> None:
    snap = lower_definitions(_neutral_set())
    assert len(snap.flags) == len(_neutral_set())
    assert set(snap.flags_by_key) == {
        "simple-flag",
        "multivariate-flag",
        "prop-flag",
        "override-flag",
        "disabled-flag",
    }
    # The disabled flag stays in the snapshot (known-but-off, not unknown).
    assert _d(snap.flags_by_key["disabled-flag"])["active"] is False
    assert snap.group_type_mapping == {}
    assert snap.cohorts == {}


def test_lowering_never_emits_wire_only_tokens() -> None:
    snap = lower_definitions(_neutral_set())
    for flag in snap.flags:
        assert "ensure_experience_continuity" not in flag
        assert "aggregation_group_type_index" not in _d(flag["filters"])
        for group in _d(flag["filters"]).get("groups", []):
            for prop in _d(group).get("properties", []):
                assert "type" not in _d(prop)


def test_lowering_maps_neutral_vocabulary_to_wire() -> None:
    snap = lower_definitions([_prop_gated()])
    flag = snap.flags[0]
    assert flag["active"] is True  # enabled -> active
    group = _d(_d(flag["filters"])["groups"][0])
    assert group["rollout_percentage"] == 100  # rollout_percentage passthrough
    prop = _d(group["properties"][0])
    assert prop["key"] == "plan"  # property -> key
    assert prop["operator"] == "exact"
    assert prop["value"] == "pro"


def test_lowering_defaults_operator_and_maps_negated_to_negation() -> None:
    with_negation: FeatureFlagDefinition = {
        "key": "neg-flag",
        "enabled": True,
        "conditions": [{"property_filters": [{"property": "country", "value": "US", "negated": True}]}],
    }
    snap = lower_definitions([with_negation])
    prop = _d(_d(_d(snap.flags[0]["filters"])["groups"][0])["properties"][0])
    assert prop["operator"] == "exact"
    assert prop["negation"] is True


def test_lowering_omits_multivariate_for_boolean_flag() -> None:
    snap = lower_definitions([_simple(), _multivariate()])
    assert "multivariate" not in _d(snap.flags[0]["filters"])
    assert len(_d(_d(snap.flags[1]["filters"])["multivariate"])["variants"]) == 5


def test_lowering_maps_variant_override_to_group_variant() -> None:
    snap = lower_definitions([_override()])
    assert _d(_d(snap.flags[0]["filters"])["groups"][0])["variant"] == "third-variant"


# ---------------------------------------------------------------------------------------------
# The parity proof: lowered snapshot evaluates identically to the poller-path snapshot.
# ---------------------------------------------------------------------------------------------


def test_parity_lowered_snapshot_evaluates_identically_to_poller_snapshot() -> None:
    lowered = lower_definitions(_neutral_set())
    via_poller = _poller_snapshot(_wire_set())

    for key in lowered.flags_by_key:
        lowered_value = compute_flag_locally(lowered.flags_by_key[key], _CONTEXT, lowered)
        poller_value = compute_flag_locally(via_poller.flags_by_key[key], _CONTEXT, via_poller)
        assert lowered_value == poller_value


def test_parity_lowered_snapshot_resolves_reference_correct_ground_truth() -> None:
    snap = lower_definitions(_neutral_set())
    assert compute_flag_locally(snap.flags_by_key["simple-flag"], _CONTEXT, snap) is True
    assert compute_flag_locally(snap.flags_by_key["multivariate-flag"], _CONTEXT, snap) == "second-variant"
    assert compute_flag_locally(snap.flags_by_key["prop-flag"], _CONTEXT, snap) is True
    assert compute_flag_locally(snap.flags_by_key["override-flag"], _CONTEXT, snap) == "third-variant"
    assert compute_flag_locally(snap.flags_by_key["disabled-flag"], _CONTEXT, snap) is False


def test_parity_payloads_key_by_resolved_value() -> None:
    lowered = lower_definitions(_neutral_set())
    assert _d(_d(lowered.flags_by_key["simple-flag"])["filters"])["payloads"] == {"true": json.dumps({"via": "defn"})}
    assert _d(_d(lowered.flags_by_key["multivariate-flag"])["filters"])["payloads"] == {
        "second-variant": json.dumps({"tier": "silver"})
    }


# ---------------------------------------------------------------------------------------------
# Seed-time validation — each malformed case rejects loudly; a valid set passes.
# ---------------------------------------------------------------------------------------------


def test_validation_valid_set_passes() -> None:
    validate_definitions(_neutral_set())  # no raise


def test_validation_rejects_missing_or_empty_key() -> None:
    with pytest.raises(ValidationError):
        validate_definitions([{"key": "", "enabled": True}])


def test_validation_rejects_duplicate_keys() -> None:
    with pytest.raises(ValidationError, match="duplicate key 'dup'"):
        validate_definitions([{"key": "dup", "enabled": True}, {"key": "dup", "enabled": True}])


def test_validation_rejects_operator_outside_closed_union() -> None:
    with pytest.raises(ValidationError):
        validate_definitions(
            _malformed(
                {
                    "key": "bad-op",
                    "enabled": True,
                    "conditions": [{"property_filters": [{"property": "x", "operator": "startswith", "value": "y"}]}],
                }
            )
        )


def test_validation_rejects_condition_rollout_outside_range() -> None:
    with pytest.raises(ValidationError):
        validate_definitions([{"key": "over", "enabled": True, "conditions": [{"rollout_percentage": 150}]}])
    with pytest.raises(ValidationError):
        validate_definitions([{"key": "under", "enabled": True, "conditions": [{"rollout_percentage": -1}]}])


def test_validation_rejects_variant_rollout_outside_range() -> None:
    with pytest.raises(ValidationError):
        validate_definitions([{"key": "v", "enabled": True, "variants": [{"key": "a", "rollout_percentage": 200}]}])


def test_validation_rejects_variant_bands_over_100_but_allows_under() -> None:
    with pytest.raises(ValidationError, match=r"sum to 120"):
        validate_definitions(
            [
                {
                    "key": "over-sum",
                    "enabled": True,
                    "variants": [
                        {"key": "a", "rollout_percentage": 60},
                        {"key": "b", "rollout_percentage": 60},
                    ],
                }
            ]
        )
    # < 100 is legal (the gap -> bare True) — no raise.
    validate_definitions(
        [
            {
                "key": "under-sum",
                "enabled": True,
                "variants": [
                    {"key": "a", "rollout_percentage": 30},
                    {"key": "b", "rollout_percentage": 30},
                ],
            }
        ]
    )


def test_validation_rejects_variant_override_not_naming_declared_variant() -> None:
    with pytest.raises(ValidationError, match="names no declared variant"):
        validate_definitions(
            [
                {
                    "key": "bad-override",
                    "enabled": True,
                    "conditions": [{"variant_override": "ghost"}],
                    "variants": [{"key": "real", "rollout_percentage": 100}],
                }
            ]
        )


def test_validation_rejects_empty_variants_and_empty_variant_key() -> None:
    with pytest.raises(ValidationError, match="present but empty"):
        validate_definitions([{"key": "empty-variants", "enabled": True, "variants": []}])
    with pytest.raises(ValidationError):
        validate_definitions([{"key": "empty-key", "enabled": True, "variants": [{"key": "", "rollout_percentage": 100}]}])


# ---------------------------------------------------------------------------------------------
# Dead 'false' payload key — WARN, never reject.
# ---------------------------------------------------------------------------------------------


def test_dead_false_payload_key_warns_never_rejects() -> None:
    with_dead_key: FeatureFlagDefinition = {
        "key": "off-payload",
        "enabled": True,
        "conditions": [{"property_filters": [], "rollout_percentage": 100}],
        "payloads": {"true": json.dumps({"a": 1}), "false": json.dumps({"b": 2})},
    }
    with pytest.warns(UserWarning, match="'false' payload key"):
        validate_definitions([with_dead_key])  # warns, never raises
    # The type stays permissive — the false key round-trips into the lowered snapshot untouched.
    snap = lower_definitions([with_dead_key])
    assert "false" in _d(_d(snap.flags_by_key["off-payload"])["filters"])["payloads"]


# ---------------------------------------------------------------------------------------------
# Bar A — the neutral type + lowering are backend-independent.
# ---------------------------------------------------------------------------------------------


def test_bar_a_backend_independent_authored_definitions() -> None:
    snap = lower_definitions(_neutral_set())
    # No adapter, no network: authoring + lowering + the pure evaluator resolve the set directly.
    values = [compute_flag_locally(snap.flags_by_key[key], _CONTEXT, snap) for key in snap.flags_by_key]
    assert "second-variant" in values
    assert "third-variant" in values
    assert True in values
    assert False in values


# ---------------------------------------------------------------------------------------------
# Public-surface contract: the neutral TYPE family is on the public `analytics_kit` surface; the
# lowering/validator are internal machinery S2 wires (kept OFF the public package for parity with the
# TS structural-leak guard).
# ---------------------------------------------------------------------------------------------


def test_public_surface_contract() -> None:
    import analytics_kit

    for neutral_type in (
        "FeatureFlagDefinition",
        "FlagCondition",
        "PropertyFilter",
        "FlagVariant",
        "FlagFilterValue",
        "FlagFilterOperator",
    ):
        assert neutral_type in analytics_kit.__all__
    # The lowering/validator are internal machinery — NOT on the public package surface.
    assert "lower_definitions" not in analytics_kit.__all__
    assert "validate_definitions" not in analytics_kit.__all__
    assert not hasattr(analytics_kit, "lower_definitions")
    assert not hasattr(analytics_kit, "validate_definitions")
