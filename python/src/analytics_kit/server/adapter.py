"""The server target adapter — the real backend the provider talks to.

The provider (already built) mints, gates, and types every event, then calls
``adapter.capture(event)``. This adapter is that seam's server realization: its sole data
verb enqueues the already-minted event onto a delivery seam, and its lifecycle/consent/
identity members back the rest of the SPI.

The enqueue seam is an injected ``EventSink`` — a plain ``NeutralEvent -> None`` callable the
adapter holds and routes ``capture`` to. For this story it defaults to an in-memory buffer;
the batch queue + background daemon thread that replaces it is a later slice of the
server-capture cycle, dropped in by construction with no reshaping of this adapter.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Protocol, runtime_checkable

from ..adapter import ConsentState, NeutralResponse
from ..neutral_event import NeutralEvent

LIBRARY_ID = "analytics-kit"

EventSink = Callable[[NeutralEvent], None]
"""The enqueue seam: the adapter routes ``capture`` to this callable. The default in-memory
buffer is replaced by the queue-backed consumer later in the cycle, injected by construction."""


@runtime_checkable
class LifecycleSink(Protocol):
    """A sink that also owns delivery lifecycle. When the injected sink is the batch consumer,
    the adapter's ``flush``/``shutdown`` drive its drain; a plain-callable sink has neither and
    the lifecycle verbs are inert (the default in-memory buffer needs no drain)."""

    def flush(self) -> None: ...

    def shutdown(self) -> None: ...


class _BufferSink:
    """The default enqueue target — an in-memory buffer standing in for the batch queue."""

    def __init__(self) -> None:
        self.events: list[NeutralEvent] = []

    def __call__(self, event: NeutralEvent) -> None:
        self.events.append(event)


class ServerAdapter:
    """The server backend adapter satisfying ``AnalyticsAdapter`` structurally.

    ``capture`` enqueues an already-minted :class:`~analytics_kit.NeutralEvent` onto the
    injected sink — it never re-mints, re-gates, or re-types (the provider did that). Consent
    is an instance-level field backing the SPI getters/setter; ``send`` stays the neutral
    string-bodied transport primitive (batch delivery is adapter-internal and bypasses it).
    """

    def __init__(
        self,
        *,
        version: str,
        sink: EventSink | None = None,
        consent: ConsentState = "granted",
    ) -> None:
        self._sink: EventSink = sink if sink is not None else _BufferSink()
        self._version = version
        self._consent: ConsentState = consent

    def capture(self, event: NeutralEvent) -> None:
        """Enqueue the already-minted event onto the delivery seam."""
        self._sink(event)

    def flush(self) -> None:
        """Force-send buffered events by driving the injected sink's drain, when it owns one."""
        if isinstance(self._sink, LifecycleSink):
            self._sink.flush()

    def shutdown(self) -> None:
        """Drain and quiesce for process exit by driving the injected sink's shutdown, when it
        owns one."""
        if isinstance(self._sink, LifecycleSink):
            self._sink.shutdown()

    def send(
        self,
        url: str,
        method: str,
        headers: dict[str, str],
        body: str | None = None,
    ) -> NeutralResponse:
        """Neutral HTTP send primitive; the real transport lands with batch delivery."""
        return NeutralResponse(status=0, body="")

    def get_consent_state(self) -> ConsentState:
        """Read the adapter's consent decision."""
        return self._consent

    def set_consent_state(self, state: ConsentState) -> None:
        """Set the adapter's consent decision."""
        self._consent = state

    def get_library_id(self) -> str:
        """The neutral library identifier reported on the wire."""
        return LIBRARY_ID

    def get_library_version(self) -> str:
        """The library version reported on the wire."""
        return self._version
