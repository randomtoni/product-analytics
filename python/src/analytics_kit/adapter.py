"""The adapter SPI — the vendor-neutral backend seam.

``AnalyticsAdapter`` is a structural ``Protocol``, not an ABC: a backend adapter satisfies
the seam by matching its shape, without importing or subclassing a library base — the
coupling the neutral seam exists to avoid. It is capture-only plus lifecycle: the sole
data verb is ``capture(event)``; trait/group intent is minted by the provider into
discriminated ``NeutralEvent``\\ s and routed through the same ``capture`` path, so the
adapter surface stays maximally neutral and stateless (no persisted identity, no
super-property store).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol

from .neutral_event import NeutralEvent

ConsentState = Literal["granted", "denied", "pending"]
"""Consent tri-state, declared for parity. Server consent is a weakened instance-level send
switch (the ``pending`` state has no durable per-user store server-side)."""


@dataclass
class NeutralResponse:
    """The neutral transport response returned by the adapter's send primitive."""

    status: int
    body: str


class AnalyticsAdapter(Protocol):
    """The backend seam a target adapter satisfies structurally.

    Capture-only plus lifecycle. Consumer captures and provider-minted internal events
    (trait/group updates, discriminated by ``event.internal_kind``) both arrive through
    ``capture``. Persistence and identity primitives are absent — they have no server home.
    """

    def capture(self, event: NeutralEvent) -> None:
        """Enqueue an event for delivery — the sole data verb."""
        ...

    def flush(self) -> None:
        """Force-send buffered events; leaves the adapter usable afterward."""
        ...

    def shutdown(self) -> None:
        """Drain and quiesce for process exit."""
        ...

    def send(
        self,
        url: str,
        method: str,
        headers: dict[str, str],
        body: str | None = None,
    ) -> NeutralResponse:
        """Neutral HTTP send primitive — transport-agnostic, no framework binding."""
        ...

    def get_consent_state(self) -> ConsentState:
        """Read the current consent decision."""
        ...

    def set_consent_state(self, state: ConsentState) -> None:
        """Set the current consent decision."""
        ...

    def get_library_id(self) -> str:
        """The neutral library identifier reported on the wire."""
        ...

    def get_library_version(self) -> str:
        """The library version reported on the wire."""
        ...
