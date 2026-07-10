"""The flag-eval transport seam — the injectable HTTP send hook + its stdlib default.

``FlagTransport`` mirrors the neutral ``send(url, method, headers, body) -> NeutralResponse``
shape the ingest SPI and the query transport use, so one vocabulary covers every HTTP send in
the library. The default :class:`_UrllibFlagTransport` is a stdlib ``urllib`` request (zero new
dependency); it is typed structurally against :class:`FlagTransport`, so no ``urllib`` handle
crosses the seam — only the neutral :class:`~analytics_kit.NeutralResponse` does.

The urllib gotcha the default handles: ``urllib.request.urlopen`` RAISES ``HTTPError`` on EVERY
non-2xx. A failed flag round-trip must degrade (the adapter maps a non-OK status to the neutral
``unresolved`` snapshot), so the transport catches ``HTTPError`` and returns the real status
rather than letting the exception propagate and crash ``evaluate``. Flags degrade; they do not
retry like capture.
"""

from __future__ import annotations

import urllib.error
import urllib.request
from typing import Protocol, runtime_checkable

from ..adapter import DEFAULT_HTTP_TIMEOUT_SECONDS, NeutralResponse

_STATUS_NO_RESPONSE = 0


@runtime_checkable
class FlagTransport(Protocol):
    """The adapter-owned HTTP send seam for the flag-eval path — the injectable transport hook.

    Mirrors the neutral SPI ``send`` signature exactly (same verb, same arg order) so one
    vocabulary covers every HTTP send in the library. Returns the neutral
    :class:`~analytics_kit.NeutralResponse` (``status`` + ``body``), so no vendor or third-party
    client handle crosses the seam; the adapter reads ``.status``/``.body`` and decodes the body
    itself. Sync by posture — no coroutine.

    ``runtime_checkable`` so :class:`~analytics_kit.flags.config.FlagClientConfig` can hold it
    opaque under ``arbitrary_types_allowed`` (Pydantic ``isinstance``-guards an arbitrary-typed
    field) — the same posture the ingest ``Taxonomy`` field and the query transport use.
    """

    def send(
        self,
        url: str,
        method: str,
        headers: dict[str, str],
        body: str | None = None,
    ) -> NeutralResponse:
        """Send an HTTP request and return the neutral response."""
        ...


class _UrllibFlagTransport:
    """The default flag-eval transport — a stdlib ``urllib`` request (zero new dependency).

    Typed against :class:`FlagTransport` structurally, so no ``urllib`` handle crosses the seam.
    A non-2xx returns its real status (``urllib`` RAISES ``HTTPError``, caught here); a genuine
    network failure normalizes to status ``0`` — the adapter maps either onto the degraded
    ``unresolved`` snapshot. No raw ``urllib`` exception ever crosses the seam.
    """

    def send(
        self,
        url: str,
        method: str,
        headers: dict[str, str],
        body: str | None = None,
    ) -> NeutralResponse:
        data = body.encode("utf-8") if body is not None else None
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=DEFAULT_HTTP_TIMEOUT_SECONDS) as response:  # noqa: S310
                return NeutralResponse(status=response.status, body=response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            try:
                error_body = error.read().decode("utf-8", errors="replace")
            except Exception:  # noqa: BLE001 — a body-read failure never crosses the seam.
                error_body = ""
            return NeutralResponse(status=error.code, body=error_body)
        except Exception:  # noqa: BLE001 — a timeout or any network failure normalizes here; no raw error crosses the seam.
            return NeutralResponse(status=_STATUS_NO_RESPONSE, body="")
