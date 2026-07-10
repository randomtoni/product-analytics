"""An in-memory recording adapter — Quillstream's test double for the backend seam.

It satisfies the shipped ``AnalyticsAdapter`` Protocol structurally (mypy enforces the shape;
there is no base class to subclass). Every capture is buffered into an inspectable list instead
of being delivered, so a test can assert on what the product emitted without a real backend or a
socket. Consent is ``"granted"`` so the provider never suppresses a send — a non-granting
recorder would make capture assertions pass vacuously.
"""

from __future__ import annotations

from analytics_kit import ConsentState, NeutralEvent, NeutralResponse

LIBRARY_ID = "quillstream-example"
LIBRARY_VERSION = "0.0.0"


class RecordingAdapter:
    """Buffers captured events in memory; never touches the network."""

    def __init__(self) -> None:
        self.captures: list[NeutralEvent] = []
        self.flushed = 0
        self.shut_down = 0
        self._consent: ConsentState = "granted"

    def capture(self, event: NeutralEvent) -> None:
        self.captures.append(event)

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
        return LIBRARY_ID

    def get_library_version(self) -> str:
        return LIBRARY_VERSION
