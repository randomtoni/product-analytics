"""Tests for the adapter-internal wire-mapper — ``NeutralEvent`` to the wire shape.

These pin the port of the TS-node contract (``wire-mapper.ts`` + E7-S5): ``dedupe_id`` on the
top-level ``uuid`` verbatim (never ``$insert_id``), the trait/group normalization keyed off the
STRUCTURAL ``internal_kind`` discriminant (never the event name), the single-present-bag guard,
the ``{api_key, batch, sent_at}`` envelope, and the ``_WIRE_*`` confinement (no wire token on the
neutral surface).
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

from analytics_kit.neutral_event import NeutralEvent
from analytics_kit.server import wire_mapper
from analytics_kit.server.wire_mapper import (
    assemble_batch_envelope,
    map_event_to_wire,
)


def _event(**overrides: object) -> NeutralEvent:
    base: dict[str, object] = {
        "event": "order_placed",
        "distinct_id": "user-1",
        "dedupe_id": "dd-1",
        "properties": {"amount": 42},
        "timestamp": datetime(2026, 7, 8, tzinfo=timezone.utc),
    }
    base.update(overrides)
    return NeutralEvent(**base)  # type: ignore[arg-type]


# --- plain pass-through: distinct_id/event/properties/timestamp -------------------------


def test_maps_a_neutral_event_to_the_wire_shape() -> None:
    wire = map_event_to_wire(_event())

    assert wire["event"] == "order_placed"
    assert wire["distinct_id"] == "user-1"
    assert wire["properties"] == {"amount": 42}
    assert wire["timestamp"] == "2026-07-08T00:00:00+00:00"


def test_a_no_properties_event_maps_to_a_wire_event_with_no_properties_bag() -> None:
    wire = map_event_to_wire(_event(properties=None))
    assert "properties" not in wire


def test_a_no_timestamp_event_maps_to_a_wire_event_with_no_timestamp() -> None:
    wire = map_event_to_wire(_event(timestamp=None))
    assert "timestamp" not in wire


# --- dedupe_id → top-level uuid (verbatim, idempotent); never $insert_id ----------------


def test_carries_the_dedupe_id_to_the_top_level_wire_uuid_verbatim() -> None:
    wire = map_event_to_wire(_event(dedupe_id="caller-supplied-key"))
    assert wire["uuid"] == "caller-supplied-key"


def test_same_dedupe_id_maps_to_the_same_wire_uuid_idempotent() -> None:
    a = map_event_to_wire(_event(dedupe_id="retry-key"))
    b = map_event_to_wire(_event(dedupe_id="retry-key", properties={"amount": 99}))
    assert a["uuid"] == b["uuid"] == "retry-key"


def test_does_not_emit_insert_id() -> None:
    wire = map_event_to_wire(_event())
    assert "$insert_id" not in json.dumps(wire)
    assert wire["properties"] == {"amount": 42}


# --- trait normalization: internal_kind="set_traits" → nested set/set_once --------------


def test_a_set_traits_event_maps_its_bag_to_the_nested_wire_set_key() -> None:
    wire = map_event_to_wire(
        _event(
            event="set_traits",
            internal_kind="set_traits",
            properties={"set": {"plan": "pro", "seats": 5}},
        )
    )

    assert wire["properties"] == {"set": {"plan": "pro", "seats": 5}}
    assert wire["event"] == "set_traits"


def test_a_set_once_traits_event_maps_its_bag_to_the_nested_wire_set_once_key() -> None:
    wire = map_event_to_wire(
        _event(
            event="set_traits",
            internal_kind="set_traits",
            properties={"set_once": {"first_seen": "today"}},
        )
    )

    assert wire["properties"] == {"set_once": {"first_seen": "today"}}
    assert "set" not in wire["properties"]


def test_only_the_present_trait_bag_is_emitted_never_both() -> None:
    # The provider mints exactly one of set/set_once; the absent bag is never synthesized.
    set_wire = map_event_to_wire(
        _event(event="set_traits", internal_kind="set_traits", properties={"set": {"a": 1}})
    )
    once_wire = map_event_to_wire(
        _event(event="set_traits", internal_kind="set_traits", properties={"set_once": {"b": 2}})
    )

    assert set_wire["properties"] == {"set": {"a": 1}}
    assert "set_once" not in set_wire["properties"]
    assert once_wire["properties"] == {"set_once": {"b": 2}}
    assert "set" not in once_wire["properties"]


def test_trait_bags_nest_inside_wire_properties_never_lifted_to_top_level() -> None:
    wire = map_event_to_wire(
        _event(event="set_traits", internal_kind="set_traits", properties={"set": {"plan": "pro"}})
    )

    assert "set" not in wire
    assert "set_traits" not in wire
    assert wire["properties"] == {"set": {"plan": "pro"}}


# --- group normalization: internal_kind="set_group_traits" → nested group keys ----------


def test_a_group_traits_event_maps_to_the_nested_group_wire_keys() -> None:
    wire = map_event_to_wire(
        _event(
            event="set_group_traits",
            internal_kind="set_group_traits",
            distinct_id="company_acme",
            properties={
                "group_type": "company",
                "group_key": "acme",
                "group_set": {"name": "Acme", "size": 200},
            },
        )
    )

    assert wire["properties"] == {
        "group_type": "company",
        "group_key": "acme",
        "group_set": {"name": "Acme", "size": 200},
    }


def test_no_dollar_prefixed_or_groups_vocab_on_trait_or_group_wire_events() -> None:
    trait_wire = map_event_to_wire(
        _event(event="set_traits", internal_kind="set_traits", properties={"set": {"plan": "pro"}})
    )
    group_wire = map_event_to_wire(
        _event(
            event="set_group_traits",
            internal_kind="set_group_traits",
            properties={"group_type": "company", "group_key": "acme", "group_set": {}},
        )
    )

    for wire in (trait_wire, group_wire):
        serialized = json.dumps(wire)
        assert "$set" not in serialized
        assert "$group" not in serialized
        assert "$groups" not in serialized


# --- structural recognition: internal_kind, NOT the event name (the R1 discipline) ------


def test_a_consumer_event_named_set_traits_with_no_internal_kind_passes_through_intact() -> None:
    # The untyped-hatch collision: a consumer event literally named `set_traits` arrives with
    # internal_kind=None, so it is NOT normalized — its real props survive, not stripped to
    # only the set/set_once wrapper keys.
    wire = map_event_to_wire(
        _event(event="set_traits", internal_kind=None, properties={"real_prop": 1, "another": "x"})
    )

    assert wire["event"] == "set_traits"
    assert wire["properties"] == {"real_prop": 1, "another": "x"}


def test_a_consumer_event_named_set_group_traits_with_no_internal_kind_passes_through_intact() -> (
    None
):
    wire = map_event_to_wire(
        _event(event="set_group_traits", internal_kind=None, properties={"real_prop": 2})
    )

    assert wire["event"] == "set_group_traits"
    assert wire["properties"] == {"real_prop": 2}


def test_a_consumer_prop_named_like_a_trait_bag_key_is_not_normalized() -> None:
    wire = map_event_to_wire(_event(properties={"set": "a real consumer prop"}))
    assert wire["properties"] == {"set": "a real consumer prop"}


def test_a_real_set_traits_event_still_normalizes_regression_guard() -> None:
    wire = map_event_to_wire(
        _event(event="set_traits", internal_kind="set_traits", properties={"set": {"plan": "pro"}})
    )
    assert wire["event"] == "set_traits"
    assert wire["properties"] == {"set": {"plan": "pro"}}


def test_internal_kind_is_never_emitted_on_the_wire() -> None:
    trait_wire = map_event_to_wire(
        _event(event="set_traits", internal_kind="set_traits", properties={"set": {"plan": "pro"}})
    )
    group_wire = map_event_to_wire(
        _event(
            event="set_group_traits",
            internal_kind="set_group_traits",
            properties={"group_type": "company", "group_key": "acme", "group_set": {}},
        )
    )

    for wire in (trait_wire, group_wire):
        assert "internal_kind" not in wire
        assert "internal_kind" not in json.dumps(wire)


def test_an_unrecognized_internal_kind_falls_through_to_pass_through() -> None:
    # Only set_traits/set_group_traits are minted this cycle; any other kind is pass-through.
    wire = map_event_to_wire(
        _event(event="e", internal_kind="group_identify", properties={"real": 1})
    )
    assert wire["properties"] == {"real": 1}


# --- batch envelope: {api_key, batch, sent_at} ------------------------------------------


def test_assemble_batch_envelope_wraps_mapped_events() -> None:
    envelope = assemble_batch_envelope(
        "proj-key",
        [_event(), _event(dedupe_id="dd-2")],
        "2026-07-08T12:00:00+00:00",
    )
    # Round-trip so mypy sees plain data (the wire dict values are typed `object`).
    parsed = json.loads(json.dumps(envelope))

    assert parsed["api_key"] == "proj-key"
    assert parsed["sent_at"] == "2026-07-08T12:00:00+00:00"
    assert len(parsed["batch"]) == 2
    assert parsed["batch"][0]["uuid"] == "dd-1"
    assert parsed["batch"][1]["uuid"] == "dd-2"


# --- _WIRE_* confinement: no wire token on the neutral surface ---------------------------


def test_wire_vocab_is_confined_to_module_level_wire_constants() -> None:
    # Every wire token lives in a _WIRE_* module constant — the confinement PY8 asserts.
    assert wire_mapper._WIRE_UUID_KEY == "uuid"
    assert wire_mapper._WIRE_SET_KEY == "set"
    assert wire_mapper._WIRE_SET_ONCE_KEY == "set_once"
    assert wire_mapper._WIRE_GROUP_TYPE_KEY == "group_type"
    assert wire_mapper._WIRE_GROUP_KEY_KEY == "group_key"
    assert wire_mapper._WIRE_GROUP_SET_KEY == "group_set"
    assert wire_mapper._WIRE_API_KEY == "api_key"
    assert wire_mapper._WIRE_BATCH_KEY == "batch"
    assert wire_mapper._WIRE_SENT_AT_KEY == "sent_at"


def test_no_wire_vocab_on_the_neutral_event_surface() -> None:
    # The neutral NeutralEvent carries no wire key names as fields.
    fields = set(NeutralEvent.__dataclass_fields__)
    for token in ("uuid", "api_key", "batch", "sent_at"):
        assert token not in fields
