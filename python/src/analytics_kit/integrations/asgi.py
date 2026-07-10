"""ASGI request-scoped context middleware — the async-server half of the framework bindings.

A pure ASGI-3 middleware: it wraps an ASGI application and opens a
:func:`~analytics_kit.integrations.new_context` around each request, so an async handler can
capture against the request's ``distinct_id`` + tags without threading them. It works for any
ASGI app (FastAPI, Starlette, …) — ASGI is a protocol, not a package, so this middleware imports
NO framework and constructs + runs with no consumer extra installed. The documented FastAPI/
Starlette wiring is what the ``analytics-kit[fastapi]`` extra gates, not this middleware's imports.

``contextvars`` is task-local — each asyncio task gets its own copy — so the same synchronous
:func:`new_context` core is async-safe for concurrent requests with no async-specific machinery.
The ``async def __call__`` here is the ASGI PROTOCOL signature an async server requires, NOT an
async client: no asyncio module, no event loop, no async delivery. A ``capture(...)`` in the
handler stays synchronous and offloads delivery to the background thread — the sync client works
inside an async server. The middleware provides the SCOPE only; the consumer binds the request's
identity/tags inside it (this layer never reads the request, headers, or assumes a user model).
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable, MutableMapping

from .context import new_context

Scope = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[MutableMapping[str, Any]]]
Send = Callable[[MutableMapping[str, Any]], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]


class RequestContextASGIMiddleware:
    """Open a request-scoped analytics context around each HTTP request.

    Follows the pure ASGI-3 middleware shape: ``__init__`` stores the wrapped app, and
    ``async def __call__(scope, receive, send)`` awaits the app inside a
    :func:`~analytics_kit.integrations.new_context` block so the request-scoped context is live for
    the whole downstream call and torn down after it returns — no leak across concurrent requests
    (``contextvars`` is task-local). Only ``http`` scopes are wrapped; ``lifespan`` and
    ``websocket`` scopes pass straight through, so the per-request context never spans the app
    lifetime or a long-lived socket. A consumer binds the request's ``distinct_id`` (via
    ``set_context_distinct_id``) and any ``add_tag(...)`` inside the context; this middleware
    decides nothing about identity.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        with new_context():
            await self.app(scope, receive, send)
