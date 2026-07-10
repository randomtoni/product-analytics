"""Substrate tests for the adapter SPI, the neutral event, and the capability ports.

These exercise the structural-conformance guarantee (a class satisfies ``AnalyticsAdapter``
without importing/subclassing it), the load-bearing dataclass field order, and the plain
(non-Pydantic) shape of the two dataclasses.
"""

from __future__ import annotations

import dataclasses
from datetime import datetime, timezone

import pytest

from analytics_kit import (
    AnalyticsAdapter,
    ConsentState,
    InternalKind,
    NeutralEvent,
    NeutralResponse,
)


class _FakeAdapter:
    """A minimal capture-only adapter — deliberately does NOT subclass AnalyticsAdapter."""

    def __init__(self) -> None:
        self.captured: list[NeutralEvent] = []
        self._consent: ConsentState = "granted"

    def capture(self, event: NeutralEvent) -> None:
        self.captured.append(event)

    def flush(self) -> None:
        return None

    def shutdown(self) -> None:
        return None

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
    """Bar-A proof at the type level: mypy accepts _FakeAdapter as an AnalyticsAdapter."""


def test_fake_adapter_conforms_structurally() -> None:
    adapter = _FakeAdapter()
    _conforms(adapter)
    assert AnalyticsAdapter not in type(adapter).__mro__


def test_adapter_protocol_is_not_runtime_checkable() -> None:
    # A plain (non-@runtime_checkable) Protocol rejects isinstance — the factory selects
    # by supplied-vs-None, never isinstance, so we deliberately leave it off.
    with pytest.raises(TypeError):
        isinstance(_FakeAdapter(), AnalyticsAdapter)  # type: ignore[misc]


def test_capture_routes_events_through_the_adapter() -> None:
    adapter = _FakeAdapter()
    event = NeutralEvent(event="signed_up", distinct_id="u1", dedupe_id="d1")
    adapter.capture(event)
    assert adapter.captured == [event]


def test_neutral_event_required_fields_are_positional() -> None:
    event = NeutralEvent("signed_up", "u1", "d1")
    assert event.event == "signed_up"
    assert event.distinct_id == "u1"
    assert event.dedupe_id == "d1"


def test_neutral_event_optionals_default_to_none() -> None:
    event = NeutralEvent(event="signed_up", distinct_id="u1", dedupe_id="d1")
    assert event.properties is None
    assert event.timestamp is None
    assert event.internal_kind is None


def test_neutral_event_accepts_all_fields() -> None:
    ts = datetime(2026, 7, 9, tzinfo=timezone.utc)
    kind: InternalKind = "set_traits"
    event = NeutralEvent(
        event="$set",
        distinct_id="u1",
        dedupe_id="d1",
        properties={"plan": "pro"},
        timestamp=ts,
        internal_kind=kind,
    )
    assert event.properties == {"plan": "pro"}
    assert event.timestamp == ts
    assert event.internal_kind == "set_traits"


def test_neutral_event_field_order_is_required_before_defaulted() -> None:
    names = [f.name for f in dataclasses.fields(NeutralEvent)]
    assert names == ["event", "distinct_id", "dedupe_id", "properties", "timestamp", "internal_kind"]
    required = [f.name for f in dataclasses.fields(NeutralEvent) if f.default is dataclasses.MISSING]
    assert required == ["event", "distinct_id", "dedupe_id"]


def test_neutral_event_has_no_browser_only_fields() -> None:
    names = {f.name for f in dataclasses.fields(NeutralEvent)}
    assert "session_id" not in names
    assert "is_page_view" not in names
    assert "enrichment_profile" not in names


def test_neutral_response_is_a_plain_dataclass() -> None:
    response = NeutralResponse(status=0, body="")
    assert dataclasses.is_dataclass(response)
    assert response.status == 0
    assert response.body == ""
