"""Server-capture exercise: the three ingest verbs through the recording harness (PY4 surface).

Quillstream drives ``capture`` / ``set`` / ``set_group_traits`` across its own taxonomy and
asserts on-list props reach the recorder's in-memory stream. It also pins the real seam split:
the allowlist gate runs on ALL THREE verbs, but the taxonomy prop-type validator runs ONLY on
``capture`` (the event name selects the prop shape; the trait/group bags are not name-selected).
Every assertion is in-memory against the recording adapter — never a socket.
"""

from __future__ import annotations

import pytest

from quillstream import QuillstreamHarness, create_quillstream_analytics
from quillstream.config import quillstream_config


def _keyed_harness() -> QuillstreamHarness:
    return create_quillstream_analytics(quillstream_config(key="quillstream-ingest-key"))


def test_capture_across_taxonomy_records_on_list_props() -> None:
    harness = _keyed_harness()
    assert harness.recorder is not None

    harness.analytics.capture("user-1", "workspace_created", {"plan": "pro", "seats": 5})
    harness.analytics.capture(
        "user-1", "document_created", {"document_id": "doc-1", "template": "blank"}
    )
    harness.analytics.capture("user-1", "draft_saved", {"document_id": "doc-1", "word_count": 812})
    harness.analytics.capture(
        "user-1", "document_published", {"document_id": "doc-1", "public": True}
    )

    captures = harness.recorder.captures
    assert [c.event for c in captures] == [
        "workspace_created",
        "document_created",
        "draft_saved",
        "document_published",
    ]
    # Super-properties merge onto every capture alongside the on-list event props.
    assert captures[0].properties == {
        "app": "quillstream",
        "environment": "production",
        "plan": "pro",
        "seats": 5,
    }
    assert captures[1].properties is not None
    assert captures[1].properties["document_id"] == "doc-1"
    assert captures[1].properties["template"] == "blank"
    # A consumer capture carries no internal_kind discriminant.
    assert all(c.internal_kind is None for c in captures)


def test_set_mints_set_traits_event_with_the_set_bag() -> None:
    harness = _keyed_harness()
    assert harness.recorder is not None

    harness.analytics.set("user-1", {"role": "editor", "plan": "pro", "email": "u1@example.test"})

    assert len(harness.recorder.captures) == 1
    event = harness.recorder.captures[0]
    assert event.event == "set_traits"
    assert event.internal_kind == "set_traits"
    assert event.properties == {"set": {"role": "editor", "plan": "pro", "email": "u1@example.test"}}


def test_set_once_mints_the_set_once_bag() -> None:
    harness = _keyed_harness()
    assert harness.recorder is not None

    harness.analytics.set("user-1", {"role": "editor"}, once=True)

    event = harness.recorder.captures[0]
    assert event.event == "set_traits"
    assert event.internal_kind == "set_traits"
    assert event.properties == {"set_once": {"role": "editor"}}


def test_set_group_traits_mints_the_group_bag() -> None:
    harness = _keyed_harness()
    assert harness.recorder is not None

    harness.analytics.set_group_traits("workspace", "ws-1", {"name": "Acme", "seats": 25})

    assert len(harness.recorder.captures) == 1
    event = harness.recorder.captures[0]
    assert event.event == "set_group_traits"
    assert event.internal_kind == "set_group_traits"
    assert event.properties == {
        "group_type": "workspace",
        "group_key": "ws-1",
        "group_set": {"name": "Acme", "seats": 25},
    }


def test_allowlist_gates_all_three_verbs() -> None:
    # The allowlist runs on capture AND set AND set_group_traits: an off-list key raises out of
    # each verb before any mint, and the recorder stream stays clean.
    harness = _keyed_harness()
    assert harness.recorder is not None

    with pytest.raises(ValueError, match=r'property "ssn" is not on the payload allowlist'):
        harness.analytics.capture("user-1", "workspace_created", {"ssn": "000-00-0000"})
    with pytest.raises(ValueError, match=r'property "ssn" is not on the payload allowlist'):
        harness.analytics.set("user-1", {"ssn": "000-00-0000"})
    with pytest.raises(ValueError, match=r'property "ssn" is not on the payload allowlist'):
        harness.analytics.set_group_traits("workspace", "ws-1", {"ssn": "000-00-0000"})

    assert harness.recorder.captures == []


def test_capture_prop_type_is_validated() -> None:
    # capture IS prop-type-validated: `seats` is declared `number`, so a string value is a loud
    # taxonomy violation under the default throw policy — and nothing is recorded.
    harness = _keyed_harness()
    assert harness.recorder is not None

    with pytest.raises(ValueError, match=r'property "seats" for event "workspace_created"'):
        harness.analytics.capture("user-1", "workspace_created", {"seats": "five"})

    assert harness.recorder.captures == []


def test_set_and_group_traits_are_not_prop_type_validated() -> None:
    # The seam split's other half: set / set_group_traits are allowlist-gated but NOT
    # prop-type-validated (their trait shapes are not name-selected). An on-list key whose VALUE
    # would fail capture's number check (`seats` = a string) still records through the trait
    # verbs — proving the taxonomy validator is capture-scoped, not verb-wide.
    harness = _keyed_harness()
    assert harness.recorder is not None

    harness.analytics.set("user-1", {"seats": "not-a-number"})
    harness.analytics.set_group_traits("workspace", "ws-1", {"seats": "also-not-a-number"})

    assert len(harness.recorder.captures) == 2
    assert harness.recorder.captures[0].properties == {"set": {"seats": "not-a-number"}}
    assert harness.recorder.captures[1].properties == {
        "group_type": "workspace",
        "group_key": "ws-1",
        "group_set": {"seats": "also-not-a-number"},
    }
