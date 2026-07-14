"""The ASGI receiver app — the async-server half of the receiver mounts.

The INBOUND analog of ``integrations/asgi.py``'s request-context middleware, and its async
counterpart to the Django view: where the middleware WRAPS a downstream app to open a context, this
is a TERMINAL ASGI-3 app a consumer mounts on a route (``app.mount("/ingest", ReceiverASGIApp(...))``
in Starlette/FastAPI) to RECEIVE the node batch envelope and write it through the injected
:class:`~analytics_kit.receiver.Receiver`.

Pure ASGI-3 — it imports NO web framework (ASGI is a protocol, not a package), so it constructs and
runs with no consumer extra installed. The ``analytics-kit[fastapi]`` extra gates the documented
FastAPI/Starlette mounting convenience, not this app's imports — exactly as the context middleware's
extra gates documented wiring only.

Its only work is reading the request body off the ``receive`` channel (the ``http.request`` body
chunks) and flattening the raw ``scope['headers']`` list into the single-valued, case-insensitive
header bag the S1 core takes, then translating the neutral outcome to an HTTP response over ``send``
(:mod:`.mount` owns the mapping). The ``async def __call__`` is the ASGI PROTOCOL signature an async
server requires — NOT an async client; the sync core runs inline.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable, MutableMapping

from .mount import translate
from .receiver import Receiver

Scope = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[MutableMapping[str, Any]]]
Send = Callable[[MutableMapping[str, Any]], Awaitable[None]]


async def _read_body(receive: Receive) -> bytes:
    """Drain the ``http.request`` body chunks off the ASGI ``receive`` channel into one ``bytes``.

    A request body arrives as one or more ``http.request`` messages, each carrying a ``body`` chunk
    and a ``more_body`` flag; the full body is the concatenation until ``more_body`` is false (its
    default-absent value is false). No framework helper — this is the raw ASGI protocol read.
    """
    chunks: list[bytes] = []
    more_body = True
    while more_body:
        message = await receive()
        chunks.append(message.get("body", b""))
        more_body = message.get("more_body", False)
    return b"".join(chunks)


def _flatten_headers(raw_headers: object) -> dict[str, str]:
    """Flatten the raw ASGI ``scope['headers']`` list into a single-valued case-insensitive dict.

    ASGI delivers headers as a list of ``(name, value)`` BYTE tuples, and a header name may repeat
    (multi-valued). The S1 core's ``ReceiverHeaders`` is single-valued; it only reads
    ``Content-Encoding`` (case-insensitively, inside the core). Names are lowercased to a stable
    key; a repeated name keeps the LAST value (a single ``Content-Encoding`` is the only header the
    core reads, so collision handling is not load-bearing — last-wins is the conventional choice).
    """
    headers: dict[str, str] = {}
    if not isinstance(raw_headers, (list, tuple)):
        return headers
    for pair in raw_headers:
        name, value = pair
        key = bytes(name).decode("latin-1").lower()
        headers[key] = bytes(value).decode("latin-1")
    return headers


class ReceiverASGIApp:
    """A terminal ASGI-3 app that receives the node batch envelope and writes it via ``receiver``.

    Follows the pure ASGI-3 shape: ``__init__`` stores the injected :class:`Receiver`, and
    ``async def __call__(scope, receive, send)`` reads the body + headers, calls the S1 core through
    :func:`~analytics_kit.receiver.mount.translate`, and sends the HTTP response. Only ``http``
    scopes are served; a non-``http`` scope (``lifespan``/``websocket``) is a no-op — this is a
    terminal endpoint, not a middleware, so there is no downstream app to forward to. Framework-free:
    constructs and runs with no consumer extra installed.
    """

    def __init__(self, receiver: Receiver) -> None:
        self.receiver = receiver

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            return
        body = await _read_body(receive)
        headers = _flatten_headers(scope.get("headers", []))
        status, response_body = translate(self.receiver, body, headers)
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [(b"content-length", str(len(response_body)).encode("latin-1"))],
            }
        )
        await send({"type": "http.response.body", "body": response_body})
