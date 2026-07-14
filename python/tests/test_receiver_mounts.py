"""The Django + FastAPI/ASGI receiver mounts — thin wrappers over the S1 core (E19-S2).

Mirrors the request-context middleware tests' posture: each mount is driven with a FAKE request
(canned body bytes + headers) and the S1 reusable ``FakeDbExecute`` — no real Django/FastAPI server,
no real Postgres. The suite asserts (a) the core is invoked with the decoded body/headers, (b) the
neutral outcome maps to the right HTTP status (2xx accept / 4xx parse error / 5xx write failure that
never leaks the driver exception), (c) the mount does ONLY body/header read + core call + response
translation (no parse/decompress/SQL of its own), and (d) the lazy-import + lazy-re-export guards:
importing a mount without its framework does not error, and a bare ``import analytics_kit.receiver``
pulls no framework.
"""

from __future__ import annotations

import json
import logging
from typing import Any, MutableMapping

import anyio
import pytest
from db_execute_fakes import FakeDbExecute

from analytics_kit.query import DbExecuteResult
from analytics_kit.receiver import Receiver
from analytics_kit.receiver.asgi_mount import ReceiverASGIApp
from analytics_kit.receiver.django_mount import make_receiver_view


def _configure_django_settings() -> None:
    """Configure the minimal Django settings a bare ``HttpResponse`` needs (it reads
    ``DEFAULT_CHARSET``). No project is required — the mount builds only an ``HttpResponse``, so a
    one-shot ``settings.configure()`` is enough to exercise the view outside a Django server.
    """
    from django.conf import settings  # type: ignore[import-untyped]

    if not settings.configured:
        settings.configure(DEBUG=True, ALLOWED_HOSTS=["*"])


_configure_django_settings()

# --- shared fixtures: the node batch envelope on the wire -------------------------------------


def _wire_event(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "uuid": "dd-1",
        "event": "order_placed",
        "distinct_id": "user-1",
        "properties": {"amount": 42},
        "timestamp": "2026-07-08T00:00:00+00:00",
    }
    base.update(overrides)
    return base


def _envelope(batch: list[dict[str, object]]) -> dict[str, object]:
    return {"api_key": "proj-key", "batch": batch, "sent_at": "2026-07-08T12:00:00+00:00"}


def _raw_body(env: dict[str, object]) -> bytes:
    return json.dumps(env).encode("utf-8")


class _RaisingDbExecute:
    """A ``DbExecute`` whose ``execute`` raises — stands in for a driver / DB write failure.

    The seam surfaces raw driver exceptions with no neutral wrapper; the mount must map this to a
    neutral 5xx and never let the exception reach the client.
    """

    def __init__(self) -> None:
        self.calls = 0

    def execute(self, sql: str, params: object = None) -> DbExecuteResult:
        self.calls += 1
        raise RuntimeError("connection to the database failed: secret-dsn@host")


# =============================================================================================
# Django mount
# =============================================================================================


class _FakeDjangoRequest:
    """A bare Django-request stand-in exposing only ``.body`` + ``.headers`` — all the mount reads."""

    def __init__(self, body: bytes, headers: dict[str, str] | None = None) -> None:
        self.body = body
        self.headers = headers if headers is not None else {"Content-Type": "application/json"}


def test_django_view_reads_body_and_headers_and_invokes_the_core() -> None:
    fake = FakeDbExecute()
    view = make_receiver_view(Receiver(fake))
    request = _FakeDjangoRequest(_raw_body(_envelope([_wire_event()])))

    response = view(request)

    # The core was invoked with the decoded envelope — exactly one upsert for the one-event batch.
    assert len(fake.calls) == 1
    assert fake.calls[0].params is not None
    assert "dd-1" in fake.calls[0].params
    # Accept → 2xx.
    assert response.status_code == 200


def test_django_view_maps_a_malformed_body_to_4xx_without_a_db_call() -> None:
    fake = FakeDbExecute()
    view = make_receiver_view(Receiver(fake))
    request = _FakeDjangoRequest(b"not json at all")

    response = view(request)

    assert response.status_code == 400
    assert len(fake.calls) == 0


def test_django_view_maps_an_empty_batch_to_2xx_with_no_db_call() -> None:
    fake = FakeDbExecute()
    view = make_receiver_view(Receiver(fake))
    request = _FakeDjangoRequest(_raw_body(_envelope([])))

    response = view(request)

    assert response.status_code == 200
    assert len(fake.calls) == 0


def test_django_view_maps_a_db_write_failure_to_5xx_and_never_leaks_the_exception() -> None:
    raising = _RaisingDbExecute()
    view = make_receiver_view(Receiver(raising))
    request = _FakeDjangoRequest(_raw_body(_envelope([_wire_event()])))

    response = view(request)

    # The write was attempted; the driver exception is mapped to a neutral 5xx, not raised.
    assert raising.calls == 1
    assert response.status_code == 500
    # The neutral response body carries none of the driver exception detail.
    assert b"secret-dsn" not in response.content
    assert b"database failed" not in response.content


def test_translate_logs_the_swallowed_write_failure_but_keeps_the_body_empty(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # The parity peer of the TS `translate` log: an operator MUST see the cause behind the 5xx.
    # The swallowed driver exception is logged server-side (with a traceback) while the response
    # stays a neutral, empty-body 500 — no driver detail reaches the client.
    from analytics_kit.receiver.mount import translate

    raising = _RaisingDbExecute()
    with caplog.at_level(logging.ERROR, logger="analytics_kit.receiver"):
        status, body = translate(Receiver(raising), _raw_body(_envelope([_wire_event()])), {})

    assert status == 500
    assert body == b""

    records = [r for r in caplog.records if r.name == "analytics_kit.receiver"]
    assert len(records) == 1
    # The operator log carries the cause (message + traceback); the client body carries none of it.
    assert "write failed" in records[0].message
    assert records[0].exc_info is not None
    assert b"secret-dsn" not in body
    assert b"database failed" not in body


def test_django_view_forwards_gzip_content_encoding_header_to_the_core() -> None:
    import gzip

    fake = FakeDbExecute()
    view = make_receiver_view(Receiver(fake))
    gzipped = gzip.compress(_raw_body(_envelope([_wire_event()])))
    request = _FakeDjangoRequest(gzipped, headers={"Content-Encoding": "gzip"})

    response = view(request)

    # The mount passed the header through so the core gunzipped the body — proving header read,
    # and that the mount does NO decompression itself (the core did it).
    assert response.status_code == 200
    assert len(fake.calls) == 1
    assert fake.calls[0].params is not None
    assert "dd-1" in fake.calls[0].params


# --- Django lazy-import guard (absence of the [django] extra) ---------------------------------


def test_importing_django_mount_without_django_does_not_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The dev env HAS Django, so simulate a consumer without the extra by flipping the sentinel.
    import importlib

    from analytics_kit.receiver import django_mount

    monkeypatch.setattr(django_mount, "_DJANGO_AVAILABLE", False)

    # Re-importing the module must still succeed (import pulls no framework; only the factory guards).
    reloaded = importlib.import_module("analytics_kit.receiver.django_mount")
    assert reloaded is django_mount


def test_building_the_view_without_django_raises_a_neutral_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from analytics_kit.receiver import django_mount

    monkeypatch.setattr(django_mount, "_DJANGO_AVAILABLE", False)

    with pytest.raises(RuntimeError, match=r"analytics-kit\[django\]"):
        make_receiver_view(Receiver(FakeDbExecute()))


def test_django_absence_error_is_not_a_raw_module_not_found(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from analytics_kit.receiver import django_mount

    monkeypatch.setattr(django_mount, "_DJANGO_AVAILABLE", False)

    with pytest.raises(RuntimeError) as excinfo:
        make_receiver_view(Receiver(FakeDbExecute()))

    assert not isinstance(excinfo.value, ModuleNotFoundError)
    assert "No module named" not in str(excinfo.value)


# =============================================================================================
# ASGI mount
# =============================================================================================


def _http_scope(headers: list[tuple[bytes, bytes]] | None = None) -> MutableMapping[str, Any]:
    return {
        "type": "http",
        "method": "POST",
        "path": "/ingest",
        "headers": headers if headers is not None else [],
    }


def _single_message_receive(body: bytes) -> Any:
    """A ``receive`` channel delivering the whole body in one ``http.request`` message."""

    async def receive() -> MutableMapping[str, Any]:
        return {"type": "http.request", "body": body, "more_body": False}

    return receive


def _chunked_receive(chunks: list[bytes]) -> Any:
    """A ``receive`` channel delivering the body across several ``http.request`` messages."""
    remaining = list(chunks)

    async def receive() -> MutableMapping[str, Any]:
        chunk = remaining.pop(0)
        return {"type": "http.request", "body": chunk, "more_body": len(remaining) > 0}

    return receive


class _SendRecorder:
    """Records the ASGI messages the app sends — the response start + body."""

    def __init__(self) -> None:
        self.messages: list[MutableMapping[str, Any]] = []

    async def __call__(self, message: MutableMapping[str, Any]) -> None:
        self.messages.append(message)

    @property
    def status(self) -> int:
        return int(self.messages[0]["status"])

    @property
    def body(self) -> bytes:
        return bytes(self.messages[1].get("body", b""))


def _drive(app: ReceiverASGIApp, scope: MutableMapping[str, Any], receive: Any) -> _SendRecorder:
    send = _SendRecorder()
    anyio.run(app, scope, receive, send)
    return send


def test_asgi_app_reads_the_body_from_the_receive_channel_and_invokes_the_core() -> None:
    fake = FakeDbExecute()
    app = ReceiverASGIApp(Receiver(fake))

    send = _drive(app, _http_scope(), _single_message_receive(_raw_body(_envelope([_wire_event()]))))

    assert len(fake.calls) == 1
    assert fake.calls[0].params is not None
    assert "dd-1" in fake.calls[0].params
    assert send.status == 200


def test_asgi_app_drains_a_chunked_body_before_calling_the_core() -> None:
    fake = FakeDbExecute()
    app = ReceiverASGIApp(Receiver(fake))
    body = _raw_body(_envelope([_wire_event()]))
    # Split the body into three chunks — the app must concatenate them before parsing.
    chunks = [body[:10], body[10:25], body[25:]]

    send = _drive(app, _http_scope(), _chunked_receive(chunks))

    assert send.status == 200
    assert len(fake.calls) == 1


def test_asgi_app_flattens_multivalued_byte_header_list_into_the_single_valued_core_bag() -> None:
    # The gzip path proves the multi-valued ASGI byte-tuple headers were flattened to a
    # single-valued, case-insensitive mapping the core reads — Content-Encoding is mixed-case here.
    import gzip

    fake = FakeDbExecute()
    app = ReceiverASGIApp(Receiver(fake))
    gzipped = gzip.compress(_raw_body(_envelope([_wire_event()])))
    headers = [
        (b"Content-Type", b"application/json"),
        (b"Content-Encoding", b"gzip"),
    ]

    send = _drive(app, _http_scope(headers), _single_message_receive(gzipped))

    # If the header were dropped or not flattened, the core would fail to gunzip → 400.
    assert send.status == 200
    assert len(fake.calls) == 1
    assert fake.calls[0].params is not None
    assert "dd-1" in fake.calls[0].params


def test_asgi_app_maps_a_malformed_body_to_4xx_without_a_db_call() -> None:
    fake = FakeDbExecute()
    app = ReceiverASGIApp(Receiver(fake))

    send = _drive(app, _http_scope(), _single_message_receive(b"not json at all"))

    assert send.status == 400
    assert len(fake.calls) == 0


def test_asgi_app_maps_a_db_write_failure_to_5xx_and_never_leaks_the_exception() -> None:
    raising = _RaisingDbExecute()
    app = ReceiverASGIApp(Receiver(raising))

    send = _drive(app, _http_scope(), _single_message_receive(_raw_body(_envelope([_wire_event()]))))

    assert raising.calls == 1
    assert send.status == 500
    assert b"secret-dsn" not in send.body
    assert b"database failed" not in send.body


def test_asgi_app_ignores_non_http_scopes() -> None:
    fake = FakeDbExecute()
    app = ReceiverASGIApp(Receiver(fake))
    lifespan_scope: MutableMapping[str, Any] = {"type": "lifespan"}
    send = _SendRecorder()

    async def receive() -> MutableMapping[str, Any]:  # pragma: no cover - not exercised
        return {"type": "lifespan.startup"}

    anyio.run(app, lifespan_scope, receive, send)

    # A terminal endpoint: a non-http scope is a no-op — no response sent, no core call.
    assert send.messages == []
    assert len(fake.calls) == 0


def test_asgi_app_is_the_asgi_protocol_coroutine_signature() -> None:
    import inspect

    assert inspect.iscoroutinefunction(ReceiverASGIApp.__call__)
    params = list(inspect.signature(ReceiverASGIApp.__call__).parameters)
    assert params == ["self", "scope", "receive", "send"]


def test_asgi_module_references_no_web_framework_symbol() -> None:
    # The pure-ASGI-3 proof: the mount module names no framework symbol — it wraps the bare ASGI
    # protocol. (The subprocess absence test proves it imports with frameworks BLOCKED.)
    import analytics_kit.receiver.asgi_mount as asgi_module

    assert not hasattr(asgi_module, "fastapi")
    assert not hasattr(asgi_module, "starlette")


# --- ASGI end-to-end through a real Starlette route (dev-dep harness) -------------------------


def test_asgi_app_mounted_on_a_real_starlette_route_receives_and_writes() -> None:
    # Drive the terminal ASGI app mounted on a real Starlette route over httpx.ASGITransport — the
    # deprecation-free async ASGI harness. `Mount` is how a consumer mounts a raw terminal ASGI app
    # (the receiver IS the app, not a request-function endpoint). Proves it works as a real route.
    import httpx
    from starlette.applications import Starlette
    from starlette.routing import Mount

    fake = FakeDbExecute()
    app_receiver = ReceiverASGIApp(Receiver(fake))

    async def drive() -> httpx.Response:
        # `Mount("/ingest", ...)` mounts the terminal app under the `/ingest` prefix; a POST to
        # `/ingest/` reaches it (a bare `/ingest` 307-redirects to the trailing slash, which the
        # test transport does not follow).
        app = Starlette(routes=[Mount("/ingest", app=app_receiver)])
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            return await client.post("/ingest/", content=_raw_body(_envelope([_wire_event()])))

    response = anyio.run(drive)

    assert response.status_code == 200
    assert len(fake.calls) == 1
    assert fake.calls[0].params is not None
    assert "dd-1" in fake.calls[0].params


# =============================================================================================
# Lazy public export: bare import pulls no framework
# =============================================================================================


def test_lazy_reexport_exposes_the_django_view_factory_from_the_receiver_package() -> None:
    from analytics_kit.receiver import make_receiver_view as reexported

    assert reexported is make_receiver_view


def test_lazy_reexport_exposes_the_asgi_app_from_the_receiver_package() -> None:
    from analytics_kit.receiver import ReceiverASGIApp as reexported

    assert reexported is ReceiverASGIApp


def test_unknown_attribute_on_receiver_package_still_raises_attribute_error() -> None:
    import analytics_kit.receiver as receiver_pkg

    with pytest.raises(AttributeError):
        receiver_pkg.DefinitelyNotAThing


def test_bare_receiver_import_pulls_no_framework() -> None:
    # The load-bearing consumer guarantee: a bare `import analytics_kit.receiver` must not eagerly
    # load either framework mount module (each imports its framework only on name access). Prove it
    # in a subprocess whose import machinery raises on any django/fastapi/starlette import — the
    # bare receiver import must still succeed, and neither mount submodule may be loaded.
    import subprocess
    import sys

    script = (
        "import sys, importlib.abc\n"
        "class _Block(importlib.abc.MetaPathFinder):\n"
        "    def find_spec(self, name, path, target=None):\n"
        "        top = name.split('.', 1)[0]\n"
        "        if top in ('django', 'fastapi', 'starlette'):\n"
        "            raise ImportError(f'{top} blocked for this test')\n"
        "        return None\n"
        "sys.meta_path.insert(0, _Block())\n"
        "import analytics_kit.receiver\n"
        "assert 'django' not in sys.modules\n"
        "assert 'fastapi' not in sys.modules and 'starlette' not in sys.modules\n"
        # Neither mount submodule loaded — bites on an eager `from .django_mount import ...`
        # regression (whose own try/except would swallow the blocked framework import).
        "assert 'analytics_kit.receiver.django_mount' not in sys.modules\n"
        "assert 'analytics_kit.receiver.asgi_mount' not in sys.modules\n"
        "print('ok')\n"
    )
    result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "ok"


def test_the_asgi_mount_constructs_and_runs_with_web_frameworks_blocked() -> None:
    # The pure-ASGI-3 absence proof (stronger than a monkeypatch): in a subprocess whose import
    # machinery raises on any fastapi/starlette import, the ASGI app still constructs AND serves a
    # request end-to-end. The [fastapi] extra gates the documented mounting, not this app's imports.
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
        "import json\n"
        "import anyio\n"
        "from analytics_kit.receiver import Receiver, ReceiverASGIApp\n"
        "from analytics_kit.query import DbExecuteResult\n"
        "class _Fake:\n"
        "    def __init__(self):\n"
        "        self.calls = 0\n"
        "    def execute(self, sql, params=None):\n"
        "        self.calls += 1\n"
        "        return DbExecuteResult()\n"
        "fake = _Fake()\n"
        "app = ReceiverASGIApp(Receiver(fake))\n"
        "env = {'api_key': 'k', 'batch': [{'uuid': 'u', 'event': 'e', 'distinct_id': 'd'}]}\n"
        "body = json.dumps(env).encode('utf-8')\n"
        "sent = []\n"
        "async def receive():\n"
        "    return {'type': 'http.request', 'body': body, 'more_body': False}\n"
        "async def send(m):\n"
        "    sent.append(m)\n"
        "scope = {'type': 'http', 'method': 'POST', 'path': '/ingest', 'headers': []}\n"
        "anyio.run(app, scope, receive, send)\n"
        "assert sent[0]['status'] == 200, sent\n"
        "assert fake.calls == 1\n"
        "assert 'fastapi' not in sys.modules and 'starlette' not in sys.modules\n"
        "print('ok')\n"
    )
    result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "ok"
