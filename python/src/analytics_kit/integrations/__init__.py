"""Framework bindings — the optional per-request integration layer.

The server analog of the React binding: a ``contextvars`` request scope + a ``@scoped`` decorator
carry a ``distinct_id`` + tags through a request, and :func:`context` gives a handler a
context-aware capture view. The Django and ASGI/FastAPI middlewares (later stories, behind their
extras) are thin wrappers over :func:`new_context`.

Two surfaces are public: the scope core (``new_context`` + the accessors — what a middleware
drives) and the consumer path (:func:`context` + :func:`scoped` — what a handler calls).

The framework middlewares are re-exported LAZILY (via ``__getattr__``): a bare
``import analytics_kit.integrations`` never pulls a framework, and the middleware module — which
imports its framework — is loaded only when the name is actually accessed.
"""

from __future__ import annotations

from typing import Any

from .context import (
    ContextScope,
    ScopedContextView,
    add_tag,
    context,
    current_context,
    get_context_distinct_id,
    get_tags,
    new_context,
    scoped,
    set_context_distinct_id,
)

__all__ = [
    "ContextScope",
    "ScopedContextView",
    "new_context",
    "current_context",
    "set_context_distinct_id",
    "get_context_distinct_id",
    "add_tag",
    "get_tags",
    "scoped",
    "context",
    "RequestContextMiddleware",
    "RequestContextASGIMiddleware",
]

_LAZY_EXPORTS = {
    "RequestContextMiddleware": ".django",
    "RequestContextASGIMiddleware": ".asgi",
}


def __getattr__(name: str) -> Any:
    module_path = _LAZY_EXPORTS.get(name)
    if module_path is not None:
        from importlib import import_module

        module = import_module(module_path, __name__)
        return getattr(module, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
