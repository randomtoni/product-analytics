"""Django (WSGI) request-scoped context middleware, gated behind the ``analytics-kit[django]`` extra.

A thin callable middleware that opens a :func:`~analytics_kit.integrations.new_context` around each
request, so a view can capture against the request's ``distinct_id`` + tags without threading them.
The framework is imported LAZILY: importing this module without the extra installed does not import
Django and does not error — a clear neutral error is raised only when the middleware is actually
constructed. The middleware provides the SCOPE only; the consumer binds the request's identity/tags
inside it (this layer never reads ``request.user``, headers, or assumes a user model).

This is the WSGI-sync half. The ASGI/async half lives in its own module behind its own extra.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Callable

from .context import new_context

try:
    import django  # type: ignore[import-untyped] # noqa: F401

    _DJANGO_AVAILABLE = True
except ImportError:
    _DJANGO_AVAILABLE = False

if TYPE_CHECKING:
    from django.http import HttpRequest, HttpResponse  # type: ignore[import-untyped]


class RequestContextMiddleware:
    """Open a request-scoped analytics context around each Django request.

    Follows Django's callable-middleware shape: ``__init__`` stores the next handler, and a
    synchronous ``__call__`` wraps it in a :func:`~analytics_kit.integrations.new_context` block so
    the request-scoped context is live for the view and torn down after the response — no leak
    across requests. A consumer binds the request's ``distinct_id`` (via ``set_context_distinct_id``)
    and any ``add_tag(...)`` inside the context; this middleware decides nothing about identity.

    Raises a clear neutral :class:`RuntimeError` naming the ``analytics-kit[django]`` extra if
    constructed without Django installed.
    """

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        if not _DJANGO_AVAILABLE:
            raise RuntimeError(
                "analytics-kit: the request-context middleware requires the "
                "`analytics-kit[django]` extra — install it to use this middleware."
            )
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        with new_context():
            return self.get_response(request)
