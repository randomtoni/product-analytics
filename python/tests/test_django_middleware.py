"""The Django (WSGI) request-scoped context middleware + its lazy-import gate.

Two halves. The integration half (Django is a dev-dep, so it is installed here) drives the real
middleware: a request through it opens a ``new_context()``, a view binds ``distinct_id`` + tags
inside it and a ``context(analytics).capture(...)`` resolves against them, and the context is
restored after the response (no leak across two sequential requests). The absence half simulates a
consumer WITHOUT the ``[django]`` extra by monkeypatching the module sentinel: importing
``analytics_kit.integrations`` still succeeds, and constructing the middleware raises a clear neutral
error naming the ``[django]`` extra — never a raw ``ModuleNotFoundError``.
"""

from __future__ import annotations

import pytest
from analytics_kit import Analytics, ConsentState, NeutralEvent, NeutralResponse
from analytics_kit.integrations import (
    add_tag,
    context,
    current_context,
    get_context_distinct_id,
    get_tags,
    set_context_distinct_id,
)
from analytics_kit.integrations import django as django_binding
from analytics_kit.integrations.django import RequestContextMiddleware


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


class _Request:
    """A bare request stand-in — the middleware passes it through untouched."""


# --- shape: Django callable-middleware, synchronous ------------------------------------------


def test_middleware_stores_the_next_handler() -> None:
    def get_response(request: object) -> str:
        return "response"

    middleware = RequestContextMiddleware(get_response)

    assert middleware.get_response is get_response


def test_call_is_synchronous_not_a_coroutine() -> None:
    import inspect

    assert not inspect.iscoroutinefunction(RequestContextMiddleware.__call__)


def test_call_returns_the_next_handler_response() -> None:
    sentinel = object()
    middleware = RequestContextMiddleware(lambda request: sentinel)

    assert middleware(_Request()) is sentinel


# --- scope: a context is open during the handler, torn down after ----------------------------


def test_context_is_open_during_the_handler() -> None:
    seen: dict[str, object] = {}

    def get_response(request: object) -> str:
        seen["context"] = current_context()
        return "ok"

    RequestContextMiddleware(get_response)(_Request())

    assert seen["context"] is not None


def test_context_is_restored_after_the_response() -> None:
    assert current_context() is None
    RequestContextMiddleware(lambda request: "ok")(_Request())
    # The request scope is torn down — nothing leaks into the surrounding (no) context.
    assert current_context() is None


def test_consumer_binds_distinct_id_and_tags_and_capture_resolves_against_them() -> None:
    adapter = _RecordingAdapter()
    analytics = Analytics(adapter)

    def view(request: object) -> str:
        # The consumer binds identity + tags inside the middleware-opened context.
        set_context_distinct_id("req-user")
        add_tag("request_id", "r1")
        context(analytics).capture("viewed", {"clicked": True})
        return "ok"

    RequestContextMiddleware(view)(_Request())

    assert len(adapter.captured) == 1
    event = adapter.captured[0]
    assert event.distinct_id == "req-user"
    assert event.properties is not None
    assert event.properties["request_id"] == "r1"
    assert event.properties["clicked"] is True


def test_two_sequential_requests_do_not_leak_context() -> None:
    adapter = _RecordingAdapter()
    analytics = Analytics(adapter)

    def first(request: object) -> str:
        set_context_distinct_id("user-1")
        add_tag("request_id", "r1")
        context(analytics).capture("first", {})
        return "ok"

    def second(request: object) -> str:
        # A fresh request must NOT see the prior request's identity or tags.
        assert get_context_distinct_id() is None
        assert get_tags() == {}
        set_context_distinct_id("user-2")
        context(analytics).capture("second", {})
        return "ok"

    middleware_1 = RequestContextMiddleware(first)
    middleware_2 = RequestContextMiddleware(second)
    middleware_1(_Request())
    middleware_2(_Request())

    assert [e.distinct_id for e in adapter.captured] == ["user-1", "user-2"]
    # The second event carries no leaked request_id from the first request.
    second_event = adapter.captured[1]
    assert second_event.properties is not None
    assert "request_id" not in second_event.properties


def test_middleware_attaches_no_library_computed_request_metadata() -> None:
    adapter = _RecordingAdapter()
    analytics = Analytics(adapter)

    def view(request: object) -> str:
        set_context_distinct_id("req-user")
        context(analytics).capture("viewed", {})
        return "ok"

    RequestContextMiddleware(view)(_Request())

    props = adapter.captured[0].properties or {}
    # No route / request-id / url / ip / user-agent auto-injected — consumer tags only.
    for computed in ("$current_url", "$request_method", "$request_path", "$ip", "$user_agent"):
        assert computed not in props


# --- absence path: consumer without the [django] extra --------------------------------------


def test_importing_integrations_succeeds_when_django_is_absent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The dev env HAS Django, so simulate a consumer without the extra by flipping the sentinel.
    import importlib

    import analytics_kit.integrations as integrations

    monkeypatch.setattr(django_binding, "_DJANGO_AVAILABLE", False)

    # Re-importing the integrations package must still succeed (no framework pulled at import).
    reloaded = importlib.import_module("analytics_kit.integrations")
    assert reloaded is integrations


def test_constructing_middleware_without_django_raises_neutral_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(django_binding, "_DJANGO_AVAILABLE", False)

    with pytest.raises(RuntimeError, match=r"analytics-kit\[django\]"):
        RequestContextMiddleware(lambda request: "ok")


def test_absence_error_is_not_a_raw_module_not_found(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(django_binding, "_DJANGO_AVAILABLE", False)

    with pytest.raises(RuntimeError) as excinfo:
        RequestContextMiddleware(lambda request: "ok")

    # A wrapped, role-named error — not the bare ModuleNotFoundError Python would surface.
    assert not isinstance(excinfo.value, ModuleNotFoundError)
    assert "No module named" not in str(excinfo.value)


# --- lazy re-export: bare import never pulls a framework ------------------------------------


def test_lazy_reexport_exposes_middleware_from_integrations_package() -> None:
    from analytics_kit.integrations import RequestContextMiddleware as ReExported

    assert ReExported is RequestContextMiddleware


def test_unknown_attribute_on_integrations_still_raises_attribute_error() -> None:
    import analytics_kit.integrations as integrations

    with pytest.raises(AttributeError):
        integrations.DefinitelyNotAThing


def test_bare_integrations_import_does_not_pull_django() -> None:
    # The load-bearing consumer guarantee: a consumer without the [django] extra never imports
    # Django. Django IS a dev-dep here, so prove it in a subprocess whose import machinery raises
    # on any `django` import — importing the integrations package must still succeed.
    import subprocess
    import sys

    script = (
        "import sys, importlib.abc, importlib.machinery\n"
        "class _Block(importlib.abc.MetaPathFinder):\n"
        "    def find_spec(self, name, path, target=None):\n"
        "        if name == 'django' or name.startswith('django.'):\n"
        "            raise ImportError('django blocked for this test')\n"
        "        return None\n"
        "sys.meta_path.insert(0, _Block())\n"
        "import analytics_kit.integrations\n"
        "assert 'django' not in sys.modules\n"
        # Also assert the .django submodule itself never loaded — this bites on an eager
        # `from .django import ...` regression, which the 'django' check alone would miss
        # (the submodule's own try/except swallows the blocked import). Mirrors the ASGI test.
        "assert 'analytics_kit.integrations.django' not in sys.modules\n"
        "print('ok')\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "ok"
