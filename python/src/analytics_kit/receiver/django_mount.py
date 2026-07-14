"""The Django receiver view, gated behind the ``analytics-kit[django]`` extra.

The INBOUND analog of ``integrations/django.py``'s request-context middleware: where that wraps a
view to open a context, this IS the terminal view a consumer mounts on a URL route to RECEIVE the
node batch envelope and write it through the injected :class:`~analytics_kit.receiver.Receiver`. A
thin wrapper over the S1 core — its only work is reading ``request.body`` + ``request.headers`` and
translating the neutral outcome to a Django ``HttpResponse`` (:mod:`.mount` owns the mapping).

Django is imported LAZILY (same posture as the middleware): importing this module without the extra
does not import Django and does not error — a clear neutral :class:`RuntimeError` naming
``analytics-kit[django]`` is raised only when the view is actually built. The consumer wires the
returned callable as a URL route (``path("ingest", view)``).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Callable

from .mount import translate
from .receiver import Receiver

try:
    import django  # type: ignore[import-untyped] # noqa: F401

    _DJANGO_AVAILABLE = True
except ImportError:
    _DJANGO_AVAILABLE = False

if TYPE_CHECKING:
    from django.http import HttpRequest, HttpResponse  # type: ignore[import-untyped]


def make_receiver_view(receiver: Receiver) -> Callable[[HttpRequest], HttpResponse]:
    """Build a Django view that receives the node batch envelope and writes it via ``receiver``.

    The returned callable reads the request's raw body + headers, calls the S1 core through
    :func:`~analytics_kit.receiver.mount.translate`, and returns a Django ``HttpResponse`` from the
    neutral ``(status, body)`` — 2xx on accept, 4xx on a neutral parse error, 5xx if the write
    fails (the driver exception never reaches the client). The mount decides nothing about the wire.

    Raises a clear neutral :class:`RuntimeError` naming the ``analytics-kit[django]`` extra if built
    without Django installed — mirroring the request-context middleware's guard.
    """
    if not _DJANGO_AVAILABLE:
        raise RuntimeError(
            "analytics-kit: the receiver view requires the `analytics-kit[django]` extra — "
            "install it to mount the receiver on a Django route."
        )

    from django.http import HttpResponse

    def receiver_view(request: HttpRequest) -> HttpResponse:
        status, body = translate(receiver, request.body, request.headers)
        return HttpResponse(body, status=status)

    return receiver_view
