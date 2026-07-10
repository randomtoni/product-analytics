"""The whole-stack silent no-op adapter — a null object satisfying the full SPI.

Unkeyed configuration selects this adapter, making "no key ⇒ silent" a null-object
guarantee rather than a disabled flag threaded through the provider. Every SPI member is a
silent no-op: ``capture`` discards, lifecycle returns, the transport primitive returns an
empty :class:`~analytics_kit.NeutralResponse`, consent reads ``denied``, and the identity
getters report neutral placeholders. Nothing reaches the wire.
"""

from __future__ import annotations

from .adapter import ConsentState, NeutralResponse
from .neutral_event import NeutralEvent

NOOP_LIBRARY_ID = "analytics-kit"
NOOP_LIBRARY_VERSION = "0.0.0"


class NoopAdapter:
    """A null-object adapter: every verb is a silent no-op, nothing crosses the seam."""

    def capture(self, event: NeutralEvent) -> None:
        """Discard the event — the whole-stack no-op delivers nothing."""

    def flush(self) -> None:
        """Nothing is buffered; return."""

    def shutdown(self) -> None:
        """Nothing to drain; return."""

    def send(
        self,
        url: str,
        method: str,
        headers: dict[str, str],
        body: str | None = None,
    ) -> NeutralResponse:
        """Return an empty response — never contact the wire."""
        return NeutralResponse(status=0, body="")

    def get_consent_state(self) -> ConsentState:
        """The no-op withholds consent."""
        return "denied"

    def set_consent_state(self, state: ConsentState) -> None:
        """Consent has no effect on a null object; return."""

    def get_library_id(self) -> str:
        """The neutral library identifier."""
        return NOOP_LIBRARY_ID

    def get_library_version(self) -> str:
        """The neutral placeholder version."""
        return NOOP_LIBRARY_VERSION
