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

import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Protocol, runtime_checkable

from ..adapter import DEFAULT_HTTP_TIMEOUT_SECONDS, ConsentState, NeutralResponse
from ..neutral_event import NeutralEvent
from .transport import Transport, UrllibTransport

_STATUS_NO_RESPONSE = 0

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

    The gzipped batch delivery is an adapter-owned path below the neutral ``send``: the adapter
    holds an injectable :class:`~analytics_kit.server.transport.Transport` (default stdlib
    ``urllib``), typed against the adapter's own protocol so no vendor/library handle crosses
    the seam. The target-entry builds the batch consumer's delivery callback from this transport.
    """

    def __init__(
        self,
        *,
        version: str,
        sink: EventSink | None = None,
        consent: ConsentState = "granted",
        transport: Transport | None = None,
    ) -> None:
        self._sink: EventSink = sink if sink is not None else _BufferSink()
        self._version = version
        self._consent: ConsentState = consent
        self._transport: Transport = transport if transport is not None else UrllibTransport()

    @property
    def transport(self) -> Transport:
        """The adapter-owned transport the gzipped batch delivery POSTs through."""
        return self._transport

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
        """The neutral string-bodied HTTP send primitive — a method-general request.

        Distinct from the adapter's gzipped batch delivery, which owns its own binary transport
        path below the seam: this is the SPI's transport-agnostic primitive, so ``body`` stays
        ``str``. A non-2xx returns its real status (``urllib`` raises ``HTTPError``); a genuine
        network failure normalizes to ``0`` here, so no raw ``urllib`` exception crosses the seam.
        """
        data = body.encode("utf-8") if body is not None else None
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=DEFAULT_HTTP_TIMEOUT_SECONDS) as response:  # noqa: S310
                return NeutralResponse(status=response.status, body=response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            # Capture the status FIRST, then read the body defensively: send is self-contained (no
            # outer boundary backstops it), so a body-read failure must not leak a raw exception nor
            # lose the real status.
            try:
                error_body = error.read().decode("utf-8", errors="replace")
            except Exception:  # noqa: BLE001 — a body-read failure never crosses the seam.
                error_body = ""
            return NeutralResponse(status=error.code, body=error_body)
        except Exception:  # noqa: BLE001 — a timeout or any transport failure normalizes here; no raw error crosses the seam.
            return NeutralResponse(status=_STATUS_NO_RESPONSE, body="")

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
