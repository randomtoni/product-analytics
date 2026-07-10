"""Framework-binding exercise: a request-scoped distinct_id carried into a recorded capture.

Quillstream drives the shipped ASGI middleware at the CONSUMER layer — a real Starlette app over
``httpx.ASGITransport`` inside ``anyio.run(...)`` (matching the PY6 precedent; Starlette's own
``TestClient`` pairing is deprecated). The middleware opens a request-scoped context; the handler
binds ``set_context_distinct_id(...)`` + ``add_tag(...)`` inside it and ``context(analytics)``
captures through the context-scoped view onto the PY7-S1 recording adapter. The assertion is that
the recorded ``NeutralEvent`` carried the REQUEST-bound distinct_id + tags — in memory, no socket.

The middleware and the context accessors are imported from the PUBLIC ``analytics_kit.integrations``
point (never the deeper ``.asgi``/``.context`` submodules) — the honest consumer import surface the
S3 AST import-audit enforces across this example.
"""

from __future__ import annotations

import anyio
import httpx
from analytics_kit.integrations import (
    RequestContextASGIMiddleware,
    add_tag,
    context,
    set_context_distinct_id,
)
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Route

from quillstream import QuillstreamHarness, create_quillstream_analytics
from quillstream.config import quillstream_config


def _keyed_harness() -> QuillstreamHarness:
    return create_quillstream_analytics(quillstream_config(key="quillstream-ingest-key"))


def _build_app(harness: QuillstreamHarness) -> Starlette:
    async def report(request: object) -> PlainTextResponse:
        # Inside the middleware-opened context: bind identity + a request-correlation tag, then
        # capture through the context-scoped view (the ambient distinct_id supplies the identity).
        set_context_distinct_id("req-user-1")
        add_tag("request_id", "req-abc")
        context(harness.analytics).capture("document_published", {"document_id": "doc-9", "public": True})
        return PlainTextResponse("ok")

    app = Starlette(routes=[Route("/report", report)])
    app.add_middleware(RequestContextASGIMiddleware)
    return app


def test_request_carries_request_bound_distinct_id_and_tags_into_capture() -> None:
    harness = _keyed_harness()
    assert harness.recorder is not None
    app = _build_app(harness)

    async def drive() -> httpx.Response:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            return await client.get("/report")

    response = anyio.run(drive)

    assert response.status_code == 200
    assert len(harness.recorder.captures) == 1
    event = harness.recorder.captures[0]
    # The request-bound identity — supplied by the middleware-opened context, not a per-call arg.
    assert event.distinct_id == "req-user-1"
    assert event.event == "document_published"
    assert event.properties is not None
    # The request-scoped tag crossed the allowlist gate and rides on the recorded event.
    assert event.properties["request_id"] == "req-abc"
    # Alongside the call-time props and Quillstream's super-properties.
    assert event.properties["document_id"] == "doc-9"
    assert event.properties["public"] is True
    assert event.properties["app"] == "quillstream"


def test_two_sequential_requests_do_not_leak_request_scope() -> None:
    # Each request opens its own context; the second must not inherit the first's id or tag.
    harness = _keyed_harness()
    assert harness.recorder is not None

    async def first(request: object) -> PlainTextResponse:
        set_context_distinct_id("req-user-1")
        add_tag("request_id", "req-1")
        context(harness.analytics).capture("draft_saved", {"document_id": "doc-1", "word_count": 10})
        return PlainTextResponse("ok")

    async def second(request: object) -> PlainTextResponse:
        set_context_distinct_id("req-user-2")
        context(harness.analytics).capture("draft_saved", {"document_id": "doc-2", "word_count": 20})
        return PlainTextResponse("ok")

    app = Starlette(routes=[Route("/first", first), Route("/second", second)])
    app.add_middleware(RequestContextASGIMiddleware)

    async def drive() -> None:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            await client.get("/first")
            await client.get("/second")

    anyio.run(drive)

    assert [c.distinct_id for c in harness.recorder.captures] == ["req-user-1", "req-user-2"]
    second_event = harness.recorder.captures[1]
    assert second_event.properties is not None
    # The second request carries no leaked request_id from the first.
    assert "request_id" not in second_event.properties


def test_capture_outside_a_request_has_no_ambient_identity() -> None:
    # The negative half: a context capture with no open request scope raises — never a silent
    # no-identity capture (the middleware is what supplies the ambient id).
    import pytest

    harness = _keyed_harness()
    assert harness.recorder is not None

    with pytest.raises(ValueError, match="no active analytics context"):
        context(harness.analytics).capture("draft_saved", {"document_id": "d", "word_count": 1})

    assert harness.recorder.captures == []
