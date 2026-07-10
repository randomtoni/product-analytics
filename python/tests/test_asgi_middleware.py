"""The ASGI request-scoped context middleware — the async-server half of the bindings.

Four halves. The SHAPE half pins the choice: a pure ASGI-3 middleware (``__init__(app)`` +
``async def __call__(scope, receive, send)``) that imports NO framework — so it constructs + runs
with no consumer extra installed. The INTEGRATION half drives the real middleware through a
Starlette app (a dev-dep): a ``capture(...)`` inside an async handler resolves against the
request-bound ``distinct_id`` + tags. The CONCURRENCY half is the async-safety proof: two
overlapping async requests bind different ids and each captured event carries its OWN id (no
cross-task bleed — ``contextvars`` is task-local). The ABSENCE half proves the framework-free
posture — the middleware constructs + runs with ``fastapi``/``starlette`` blocked at import, and a
bare ``import analytics_kit.integrations`` never pulls the ASGI submodule.
"""

from __future__ import annotations

from typing import Any, MutableMapping

import anyio
import pytest
from analytics_kit import Analytics, ConsentState, NeutralEvent, NeutralResponse
from analytics_kit.integrations import (
    add_tag,
    context,
    current_context,
    get_context_distinct_id,
    set_context_distinct_id,
)
from analytics_kit.integrations.asgi import RequestContextASGIMiddleware, Scope


class _RecordingAdapter:
    """Capture-only adapter that records every minted event."""

    def __init__(self) -> None:
        self.captured: list[NeutralEvent] = []
        self.flushed = 0
        self.shut_down = 0
        self._consent: ConsentState = "granted"

    def capture(self, event: NeutralEvent) -> None:
        self.captured.append(event)

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
        return "analytics-kit"

    def get_library_version(self) -> str:
        return "0.0.0"


def _http_scope(path: str = "/") -> Scope:
    """A minimal ASGI HTTP scope — enough for the middleware to pass a request downstream."""
    scope: Scope = {"type": "http", "method": "GET", "path": path, "headers": []}
    return scope


async def _noop_receive() -> MutableMapping[str, Any]:  # pragma: no cover - not exercised
    return {"type": "http.request"}


async def _noop_send(
    message: MutableMapping[str, Any],
) -> None:  # pragma: no cover - not exercised
    return None


# --- shape: pure ASGI-3 middleware (no framework import) -------------------------------------


def test_middleware_stores_the_wrapped_app() -> None:
    async def app(scope: object, receive: object, send: object) -> None:
        return None

    middleware = RequestContextASGIMiddleware(app)

    assert middleware.app is app


def test_call_is_the_asgi_protocol_coroutine_signature() -> None:
    import inspect

    # The ASGI-3 protocol requires an async __call__(scope, receive, send). This is the PROTOCOL
    # signature an async server drives — not an async client — so it IS a coroutine function.
    assert inspect.iscoroutinefunction(RequestContextASGIMiddleware.__call__)
    params = list(inspect.signature(RequestContextASGIMiddleware.__call__).parameters)
    assert params == ["self", "scope", "receive", "send"]


def test_middleware_constructs_with_no_framework_needed() -> None:
    # Pure ASGI-3: no framework import to guard. The middleware constructs from a plain callable.
    async def app(scope: object, receive: object, send: object) -> None:
        return None

    assert RequestContextASGIMiddleware(app) is not None


def test_module_references_no_web_framework_symbol() -> None:
    # The pure-ASGI-3 proof: the binding module names no framework symbol — it wraps a bare ASGI
    # callable. (The subprocess absence test proves the module imports with frameworks BLOCKED;
    # asserting `not in sys.modules` here is unreliable since starlette is a dev-dep pulled in by
    # sibling tests, so the module-symbol check is the stable in-process signal.)
    import analytics_kit.integrations.asgi as asgi_module

    assert not hasattr(asgi_module, "starlette")
    assert not hasattr(asgi_module, "fastapi")


# --- scope: a context is open during the downstream app, torn down after --------------------


def test_context_is_open_during_the_downstream_app() -> None:
    seen: dict[str, object] = {}

    async def app(scope: object, receive: object, send: object) -> None:
        seen["context"] = current_context()

    async def drive() -> None:
        await RequestContextASGIMiddleware(app)(_http_scope(), _noop_receive, _noop_send)

    anyio.run(drive)

    assert seen["context"] is not None


def test_context_is_restored_after_the_response() -> None:
    async def app(scope: object, receive: object, send: object) -> None:
        return None

    async def drive() -> None:
        assert current_context() is None
        await RequestContextASGIMiddleware(app)(_http_scope(), _noop_receive, _noop_send)
        assert current_context() is None

    anyio.run(drive)


def test_capture_inside_an_async_handler_resolves_against_request_scope() -> None:
    adapter = _RecordingAdapter()
    analytics = Analytics(adapter)

    async def app(scope: object, receive: object, send: object) -> None:
        set_context_distinct_id("req-user")
        add_tag("request_id", "r1")
        context(analytics).capture("viewed", {"clicked": True})

    async def drive() -> None:
        await RequestContextASGIMiddleware(app)(_http_scope(), _noop_receive, _noop_send)

    anyio.run(drive)

    assert len(adapter.captured) == 1
    event = adapter.captured[0]
    assert event.distinct_id == "req-user"
    assert event.properties is not None
    assert event.properties["request_id"] == "r1"
    assert event.properties["clicked"] is True


# --- integration: through a real Starlette app + async test client --------------------------


def test_capture_through_a_real_starlette_app() -> None:
    from starlette.applications import Starlette
    from starlette.responses import PlainTextResponse
    from starlette.routing import Route
    from starlette.testclient import TestClient

    adapter = _RecordingAdapter()
    analytics = Analytics(adapter)

    async def handler(request: object) -> PlainTextResponse:
        set_context_distinct_id("starlette-user")
        add_tag("request_id", "s1")
        context(analytics).capture("viewed", {"path": "/report"})
        return PlainTextResponse("ok")

    app = Starlette(routes=[Route("/report", handler)])
    app.add_middleware(RequestContextASGIMiddleware)

    with TestClient(app) as client:
        response = client.get("/report")

    assert response.status_code == 200
    assert len(adapter.captured) == 1
    event = adapter.captured[0]
    assert event.distinct_id == "starlette-user"
    assert event.properties is not None
    assert event.properties["request_id"] == "s1"
    assert event.properties["path"] == "/report"


# --- concurrency: the async-safety proof (no cross-task bleed) -------------------------------


def test_two_overlapping_requests_keep_distinct_ids() -> None:
    # The async-safety proof. Two requests run concurrently under one event loop, interleaved via
    # an anyio.Event handshake so request B binds its identity WHILE request A is mid-flight. If
    # the scope were process-global (not task-local), A's captured event would carry B's id. Each
    # event must carry its OWN request's id — contextvars is copied per asyncio task.
    adapter = _RecordingAdapter()
    analytics = Analytics(adapter)

    a_bound = anyio.Event()
    b_bound = anyio.Event()

    async def request_a(scope: object, receive: object, send: object) -> None:
        set_context_distinct_id("user-a")
        a_bound.set()
        await b_bound.wait()  # yield to B, which binds its own id in the meantime
        context(analytics).capture("event-a", {})

    async def request_b(scope: object, receive: object, send: object) -> None:
        await a_bound.wait()  # let A bind first, then bind our own id concurrently
        set_context_distinct_id("user-b")
        context(analytics).capture("event-b", {})
        b_bound.set()

    async def drive() -> None:
        async with anyio.create_task_group() as tg:
            tg.start_soon(
                RequestContextASGIMiddleware(request_a), _http_scope("/a"), _noop_receive, _noop_send
            )
            tg.start_soon(
                RequestContextASGIMiddleware(request_b), _http_scope("/b"), _noop_receive, _noop_send
            )

    anyio.run(drive)

    by_event = {e.event: e.distinct_id for e in adapter.captured}
    assert by_event == {"event-a": "user-a", "event-b": "user-b"}


def test_concurrent_requests_do_not_leak_tags() -> None:
    adapter = _RecordingAdapter()
    analytics = Analytics(adapter)

    a_tagged = anyio.Event()
    b_done = anyio.Event()

    async def request_a(scope: object, receive: object, send: object) -> None:
        set_context_distinct_id("user-a")
        add_tag("tag_a", "a")
        a_tagged.set()
        await b_done.wait()
        context(analytics).capture("event-a", {})

    async def request_b(scope: object, receive: object, send: object) -> None:
        await a_tagged.wait()
        set_context_distinct_id("user-b")
        add_tag("tag_b", "b")
        context(analytics).capture("event-b", {})
        b_done.set()

    async def drive() -> None:
        async with anyio.create_task_group() as tg:
            tg.start_soon(
                RequestContextASGIMiddleware(request_a), _http_scope("/a"), _noop_receive, _noop_send
            )
            tg.start_soon(
                RequestContextASGIMiddleware(request_b), _http_scope("/b"), _noop_receive, _noop_send
            )

    anyio.run(drive)

    props_by_event = {e.event: (e.properties or {}) for e in adapter.captured}
    # Each request's event carries only its OWN tag — no bleed from the concurrently-running peer.
    assert "tag_a" in props_by_event["event-a"] and "tag_b" not in props_by_event["event-a"]
    assert "tag_b" in props_by_event["event-b"] and "tag_a" not in props_by_event["event-b"]


# --- consumer tags only: no library-computed request metadata -------------------------------


def test_middleware_attaches_no_library_computed_request_metadata() -> None:
    adapter = _RecordingAdapter()
    analytics = Analytics(adapter)

    async def app(scope: object, receive: object, send: object) -> None:
        set_context_distinct_id("req-user")
        context(analytics).capture("viewed", {})

    async def drive() -> None:
        await RequestContextASGIMiddleware(app)(_http_scope(), _noop_receive, _noop_send)

    anyio.run(drive)

    props = adapter.captured[0].properties or {}
    for computed in ("$current_url", "$request_method", "$request_path", "$ip", "$user_agent"):
        assert computed not in props


# --- fence: the ASGI protocol handler is not an async client --------------------------------


def test_binding_module_imports_no_asyncio_or_event_loop() -> None:
    # The PY2-S4 fence protects the client's delivery posture. The ASGI protocol handler an async
    # server requires is outside it — the binding creates no event loop and imports no asyncio.
    import inspect

    from analytics_kit.integrations import asgi as asgi_module

    source = inspect.getsource(asgi_module)
    # No asyncio module import and no event-loop construction/run — the async server owns the loop;
    # the binding only rides its ASGI protocol call. (The docstring names asyncio to explain the
    # task-local property, so match the import/loop mechanics, not the word.)
    assert "import asyncio" not in source
    assert "get_event_loop" not in source
    assert "new_event_loop" not in source
    assert "run_until_complete" not in source
    # The module imports asyncio via no channel — assert it never landed as a bound module attr.
    assert not hasattr(asgi_module, "asyncio")


# --- lazy re-export: bare import never pulls the ASGI submodule ------------------------------


def test_lazy_reexport_exposes_asgi_middleware_from_integrations_package() -> None:
    from analytics_kit.integrations import RequestContextASGIMiddleware as ReExported

    assert ReExported is RequestContextASGIMiddleware


def test_bare_integrations_import_does_not_pull_asgi_submodule() -> None:
    # A bare `import analytics_kit.integrations` must not eagerly load the ASGI middleware module
    # (kept lazy for parity with the framework bindings). Assert the SUBMODULE is absent — this
    # bites on an eager-import regression even though the module is framework-free. (Reviewer note,
    # PY6-S2.)
    import subprocess
    import sys

    script = (
        "import sys\n"
        "import analytics_kit.integrations\n"
        "assert 'analytics_kit.integrations.asgi' not in sys.modules, 'asgi eagerly imported'\n"
        "print('ok')\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "ok"


def test_middleware_constructs_and_runs_with_web_frameworks_blocked() -> None:
    # The pure-ASGI-3 absence proof (stronger than a monkeypatched import): in a subprocess whose
    # import machinery raises on any fastapi/starlette import, the middleware still constructs AND
    # runs a request end-to-end. The [fastapi] extra gates the documented wiring, not this
    # middleware's own imports.
    import subprocess
    import sys

    script = (
        "import sys, importlib.abc\n"
        "class _Block(importlib.abc.MetaPathFinder):\n"
        "    def find_spec(self, name, path, target=None):\n"
        "        top = name.split('.', 1)[0]\n"
        "        if top in ('fastapi', 'starlette'):\n"
        "            raise ImportError(f'{top} blocked for this test')\n"
        "        return None\n"
        "sys.meta_path.insert(0, _Block())\n"
        "import anyio\n"
        "from analytics_kit import Analytics, NoopAdapter\n"
        "from analytics_kit.integrations.asgi import RequestContextASGIMiddleware\n"
        "from analytics_kit.integrations import set_context_distinct_id, context\n"
        "captured = {}\n"
        "async def app(scope, receive, send):\n"
        "    set_context_distinct_id('req-user')\n"
        "    captured['ran'] = True\n"
        "async def drive():\n"
        "    scope = {'type': 'http', 'method': 'GET', 'path': '/', 'headers': []}\n"
        "    async def recv():\n"
        "        return {'type': 'http.request'}\n"
        "    async def send(m):\n"
        "        return None\n"
        "    await RequestContextASGIMiddleware(app)(scope, recv, send)\n"
        "anyio.run(drive)\n"
        "assert captured.get('ran') is True\n"
        "assert 'fastapi' not in sys.modules and 'starlette' not in sys.modules\n"
        "print('ok')\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "ok"


def test_provider_capture_signature_unchanged() -> None:
    # The binding never mutated the shipped provider — distinct_id stays REQUIRED (Option B).
    import inspect

    params = inspect.signature(Analytics.capture).parameters
    assert params["distinct_id"].default is inspect.Parameter.empty


def test_get_context_distinct_id_is_none_outside_any_request() -> None:
    # A bare capture outside the middleware has no ambient id — the view raises, never silently
    # captures without identity.
    adapter = _RecordingAdapter()
    analytics = Analytics(adapter)

    assert get_context_distinct_id() is None
    with pytest.raises(ValueError, match="no active analytics context"):
        context(analytics).capture("orphan", {})
    assert adapter.captured == []
