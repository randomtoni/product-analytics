"""The request-scoped context core — the server analog of the React provider/hooks.

A ``contextvars``-based scope carries a ``distinct_id`` + super-prop-like tags per request or
task, so a handler can capture an event without threading the identity through every call. The
scope core (``new_context`` / ``@scoped`` / the accessors) is framework-agnostic — the Django and
ASGI middlewares are thin wrappers over ``new_context()``; a consumer/handler reaches the
context-aware capture path through :func:`context`.

The context read lives entirely here, in the binding layer. The shipped provider stays
context-agnostic (per-call ``distinct_id``, no ambient identity): :func:`context` resolves the id
and merges the tags at the CALL SITE, then delegates to the provider's unmodified ``capture`` — so
tags cross the allowlist gate and the taxonomy validator exactly like any other property.
"""

from __future__ import annotations

import contextvars
from collections.abc import Callable
from contextlib import contextmanager
from functools import wraps
from inspect import iscoroutinefunction
from typing import TYPE_CHECKING, Any, Awaitable, Iterator, TypeVar, cast

if TYPE_CHECKING:
    from analytics_kit.neutral_event import NeutralProperties
    from analytics_kit.provider import Analytics


class ContextScope:
    """One request/task scope: an optional ``distinct_id`` + a tag bag, chained to its parent.

    A child inherits its parent's ``distinct_id`` + tags unless ``fresh`` is set (an isolated
    scope). A child's own ``distinct_id`` overrides for its scope; on a tag-key collision the
    child value wins (parent-first collect, then child update).
    """

    def __init__(self, parent: ContextScope | None = None, fresh: bool = False) -> None:
        self.parent = parent
        self.fresh = fresh
        self.distinct_id: str | None = None
        self.tags: dict[str, object] = {}

    def set_distinct_id(self, distinct_id: str) -> None:
        self.distinct_id = distinct_id

    def add_tag(self, key: str, value: object) -> None:
        self.tags[key] = value

    def get_distinct_id(self) -> str | None:
        if self.distinct_id is not None:
            return self.distinct_id
        if self.parent is not None and not self.fresh:
            return self.parent.get_distinct_id()
        return None

    def collect_tags(self) -> dict[str, object]:
        if self.parent is not None and not self.fresh:
            tags = self.parent.collect_tags()
            tags.update(self.tags)
            return tags
        return self.tags.copy()


_context_scope: contextvars.ContextVar[ContextScope | None] = contextvars.ContextVar(
    "analytics_kit_context_scope", default=None
)


def current_context() -> ContextScope | None:
    """Read the active context scope, or ``None`` when no context is open."""
    return _context_scope.get()


@contextmanager
def new_context(fresh: bool = False) -> Iterator[ContextScope]:
    """Open a context scope active for the ``with`` block; restore the previous scope on exit.

    A nested ``new_context()`` inherits the parent's ``distinct_id`` + tags by default; with
    ``fresh=True`` it starts isolated (no inheritance). The previous scope is restored via a
    ``contextvars`` token reset, so nothing leaks across requests.
    """
    scope = ContextScope(parent=_context_scope.get(), fresh=fresh)
    token = _context_scope.set(scope)
    try:
        yield scope
    finally:
        _context_scope.reset(token)


def set_context_distinct_id(distinct_id: str) -> None:
    """Set the active context's ``distinct_id`` — no-op when no context is open."""
    scope = _context_scope.get()
    if scope is not None:
        scope.set_distinct_id(distinct_id)


def get_context_distinct_id() -> str | None:
    """Read the active context's resolved ``distinct_id`` (walking parents), or ``None``."""
    scope = _context_scope.get()
    if scope is not None:
        return scope.get_distinct_id()
    return None


def add_tag(key: str, value: object) -> None:
    """Add a request-scoped tag to the active context — no-op when no context is open."""
    scope = _context_scope.get()
    if scope is not None:
        scope.add_tag(key, value)


def get_tags() -> dict[str, object]:
    """Read the active context's resolved tag bag (parent-merged), or ``{}`` when none is open."""
    scope = _context_scope.get()
    if scope is not None:
        return scope.collect_tags()
    return {}


_F = TypeVar("_F", bound=Callable[..., Any])


def scoped(fresh: bool = False) -> Callable[[_F], _F]:
    """Wrap a function so it runs inside a :func:`new_context`.

    Async-aware: applied to an ``async def``, returns an ``async def`` wrapper that opens the
    (synchronous) ``new_context()`` and ``await``\\ s the coroutine INSIDE the live scope — so the
    scope is live for the coroutine's actual execution, not torn down before it runs. Applied to a
    sync function, returns a sync wrapper. Both preserve the wrapped function's metadata.
    """

    def decorator(func: _F) -> _F:
        if iscoroutinefunction(func):
            async_func = cast(Callable[..., Awaitable[Any]], func)

            @wraps(func)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                with new_context(fresh=fresh):
                    return await async_func(*args, **kwargs)

            return cast(_F, async_wrapper)

        @wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            with new_context(fresh=fresh):
                return func(*args, **kwargs)

        return cast(_F, wrapper)

    return decorator


class ScopedContextView:
    """A request-scoped capture view bound to an :class:`Analytics` instance.

    Captured once per request (``scoped = context(analytics)``), it exposes ``capture`` without a
    required ``distinct_id`` — the active context supplies it. It reads the context and delegates
    to the instance's UNMODIFIED ``capture``; it never touches the provider's private state.
    """

    def __init__(self, analytics: Analytics) -> None:
        self._analytics = analytics

    def capture(
        self,
        event: str,
        properties: NeutralProperties | None = None,
        *,
        distinct_id: str | None = None,
        dedupe_id: str | None = None,
    ) -> None:
        """Capture ``event`` for the context's identity, merging the context tags.

        ``distinct_id`` resolves to the explicit ``distinct_id=`` kwarg if given (the escape
        hatch — capturing for a different user than the request's ambient identity), else the
        active context's ``distinct_id``. With neither present a clear neutral error is raised —
        never a silent no-identity capture.

        Tags merge under the call-time ``properties`` (call-time wins on collision) and flow
        through the provider's unmodified ``capture``: the provider then prepends its
        super-properties, so the final bag is ``{**super, **tags, **call}`` — and the tags cross
        the allowlist gate + taxonomy validator on that unmodified path.
        """
        resolved_distinct_id = distinct_id if distinct_id is not None else get_context_distinct_id()
        if resolved_distinct_id is None:
            raise ValueError(
                "analytics-kit: no active analytics context and no explicit distinct_id"
            )
        merged: dict[str, object] = {**get_tags(), **(properties or {})}
        self._analytics.capture(resolved_distinct_id, event, merged, dedupe_id=dedupe_id)


def context(analytics: Analytics) -> ScopedContextView:
    """Return a request-scoped capture view bound to ``analytics`` (a free accessor, not a method).

    The view reads the active context for its ``distinct_id`` + tags at each ``capture`` call. It
    is a FREE function taking the instance — the shipped provider surface is left untouched.
    """
    return ScopedContextView(analytics)
