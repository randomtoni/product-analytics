"""Shared mount translation — the ONE neutral outcome→HTTP mapping both framework mounts call.

The Django view and the ASGI app are thin edges over the S1 :class:`~analytics_kit.receiver.Receiver`;
their ONLY real work is (1) read the framework request's raw body + headers, and (2) translate the
neutral outcome to the framework's HTTP response. This module owns (2) so the two mounts map
IDENTICALLY (capability parity) — a single :func:`translate` returns a framework-free
``(status, body)`` the caller wraps in its own response type.

The core's :meth:`Receiver.receive` can RAISE if the injected ``DbExecute`` raises (a driver / DB
failure — the seam surfaces raw driver exceptions with no neutral wrapper). :func:`translate` runs
the receive inside a guard so that failure surfaces as a neutral 5xx-class status — the
driver/framework exception NEVER leaks to the client (a DB outage is not a client parse error, and
its message may carry connection detail). It is not silent server-side: the swallowed exception is
logged so an operator sees the cause behind a 500. ``Accepted`` → 2xx, ``MalformedBody`` → 4xx, an
execute failure → 5xx, all with an empty body (a human-readable reason is a logging concern —
the response carries zero vendor/driver vocabulary).
"""

from __future__ import annotations

import logging

from typing_extensions import assert_never

from .receiver import Accepted, MalformedBody, ReceiveOutcome, Receiver, ReceiverHeaders

_logger = logging.getLogger("analytics_kit.receiver")

_STATUS_ACCEPTED = 200
_STATUS_MALFORMED = 400
_STATUS_WRITE_FAILED = 500

_EMPTY_BODY = b""


def translate(receiver: Receiver, body: bytes, headers: ReceiverHeaders) -> tuple[int, bytes]:
    """Run the receive and map the neutral outcome to a framework-free ``(status, body)``.

    A successful parse → 200; a neutral :class:`MalformedBody` → 400; any exception the core
    raises while writing (the injected ``DbExecute`` failing) → 500, with the exception SWALLOWED
    from the client (logged server-side) so no driver/framework detail reaches it. Both framework
    mounts call this ONE helper so their status mapping is byte-identical. The ``assert_never`` on
    the outcome union makes mypy-strict flag a missing arm if the core ever grows a third outcome —
    a new outcome must get a deliberate status, never silently default.
    """
    try:
        outcome: ReceiveOutcome = receiver.receive(body, headers)
    except Exception:  # noqa: BLE001 — the seam raises raw driver exceptions; map to a neutral 5xx.
        _logger.exception("analytics_kit receiver: write failed; returning a neutral 5xx")
        return _STATUS_WRITE_FAILED, _EMPTY_BODY
    if isinstance(outcome, Accepted):
        return _STATUS_ACCEPTED, _EMPTY_BODY
    if isinstance(outcome, MalformedBody):
        return _STATUS_MALFORMED, _EMPTY_BODY
    assert_never(outcome)
