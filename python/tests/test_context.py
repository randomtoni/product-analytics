"""Request-scoped context core + the context-aware capture path.

Exercises the ``contextvars`` scope (nesting / ``fresh`` / no-leak), the async-aware ``@scoped``
decorator (the async test PROVES the scope is live during the coroutine's execution), and the free
:func:`context` view: distinct_id resolution, tag merge/precedence, and — crucially — that context
tags cross the UNMODIFIED provider's allowlist gate + taxonomy validator.
"""

from __future__ import annotations

import asyncio
import logging

import pytest
from analytics_kit import (
    Analytics,
    ConsentState,
    NeutralEvent,
    NeutralResponse,
    define_taxonomy,
)
from analytics_kit.integrations import (
    add_tag,
    context,
    current_context,
    get_context_distinct_id,
    get_tags,
    new_context,
    scoped,
    set_context_distinct_id,
)


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


# --- new_context: scope carry, restore, no leak ------------------------------------------


def test_new_context_carries_distinct_id_and_tags_and_yields_scope() -> None:
    with new_context() as scope:
        set_context_distinct_id("u1")
        add_tag("request_id", "r1")
        assert scope.get_distinct_id() == "u1"
        assert get_context_distinct_id() == "u1"
        assert get_tags() == {"request_id": "r1"}


def test_new_context_restores_previous_scope_on_exit_no_leak() -> None:
    assert current_context() is None
    with new_context():
        set_context_distinct_id("u1")
        add_tag("t", "v")
    # The scope is fully torn down — no leak into the surrounding (no) context.
    assert current_context() is None
    assert get_context_distinct_id() is None
    assert get_tags() == {}


def test_accessors_are_noops_with_no_active_context() -> None:
    assert current_context() is None
    set_context_distinct_id("u1")
    add_tag("t", "v")
    assert get_context_distinct_id() is None
    assert get_tags() == {}


# --- new_context: nesting semantics ------------------------------------------------------


def test_nested_context_inherits_parent_distinct_id_and_tags() -> None:
    with new_context():
        set_context_distinct_id("parent")
        add_tag("shared", "p")
        with new_context():
            assert get_context_distinct_id() == "parent"
            assert get_tags() == {"shared": "p"}


def test_nested_child_overrides_distinct_id_for_its_scope() -> None:
    with new_context():
        set_context_distinct_id("parent")
        with new_context():
            set_context_distinct_id("child")
            assert get_context_distinct_id() == "child"
        # The parent's id is restored exactly once the child exits.
        assert get_context_distinct_id() == "parent"


def test_child_tags_win_over_parent_on_collision() -> None:
    with new_context():
        add_tag("k", "parent")
        add_tag("only_parent", "p")
        with new_context():
            add_tag("k", "child")
            add_tag("only_child", "c")
            assert get_tags() == {"k": "child", "only_parent": "p", "only_child": "c"}


def test_exiting_child_restores_parent_tags_exactly() -> None:
    with new_context():
        add_tag("k", "parent")
        with new_context():
            add_tag("k", "child")
            add_tag("extra", "c")
        assert get_tags() == {"k": "parent"}


def test_fresh_context_does_not_inherit_parent_distinct_id_or_tags() -> None:
    with new_context():
        set_context_distinct_id("parent")
        add_tag("shared", "p")
        with new_context(fresh=True):
            assert get_context_distinct_id() is None
            assert get_tags() == {}
            set_context_distinct_id("isolated")
            add_tag("own", "o")
            assert get_context_distinct_id() == "isolated"
            assert get_tags() == {"own": "o"}
        # Exiting the fresh child restores the parent untouched.
        assert get_context_distinct_id() == "parent"
        assert get_tags() == {"shared": "p"}


# --- @scoped: sync + async, scope live during execution ----------------------------------


def test_scoped_sync_runs_function_inside_a_context() -> None:
    seen: dict[str, object] = {}

    @scoped()
    def handler() -> None:
        set_context_distinct_id("u1")
        add_tag("t", "v")
        seen["distinct_id"] = get_context_distinct_id()
        seen["tags"] = get_tags()

    handler()

    assert seen == {"distinct_id": "u1", "tags": {"t": "v"}}
    # The scope did not leak past the decorated call.
    assert current_context() is None


def test_scoped_preserves_wrapped_metadata() -> None:
    @scoped()
    def documented() -> None:
        """A docstring to preserve."""

    @scoped()
    async def documented_async() -> None:
        """An async docstring to preserve."""

    assert documented.__name__ == "documented"
    assert documented.__doc__ == "A docstring to preserve."
    assert documented_async.__name__ == "documented_async"
    assert documented_async.__doc__ == "An async docstring to preserve."


def test_scoped_async_returns_an_async_wrapper() -> None:
    @scoped()
    async def handler() -> None: ...

    assert asyncio.iscoroutinefunction(handler)


def test_scoped_async_scope_is_live_during_coroutine_execution() -> None:
    # The load-bearing proof: the scope must be LIVE while the coroutine actually runs. A
    # sync-only wrapper would tear the context down before the awaited body executes, so reading
    # the context id from inside the coroutine would return None. We yield control mid-coroutine
    # to make the "torn down early" failure mode observable if it existed.
    seen: dict[str, object] = {}

    @scoped()
    async def handler() -> None:
        set_context_distinct_id("u1")
        add_tag("t", "v")
        await asyncio.sleep(0)
        seen["distinct_id"] = get_context_distinct_id()
        seen["tags"] = get_tags()

    asyncio.run(handler())

    assert seen == {"distinct_id": "u1", "tags": {"t": "v"}}


def test_scoped_fresh_isolates_the_decorated_call() -> None:
    seen: dict[str, object] = {}

    @scoped(fresh=True)
    def handler() -> None:
        seen["distinct_id"] = get_context_distinct_id()
        seen["tags"] = get_tags()

    with new_context():
        set_context_distinct_id("ambient")
        add_tag("ambient_tag", "x")
        handler()

    assert seen == {"distinct_id": None, "tags": {}}


# --- context(analytics): distinct_id resolution ------------------------------------------


def test_view_uses_active_context_distinct_id() -> None:
    adapter = _RecordingAdapter()
    analytics = Analytics(adapter)

    with new_context():
        set_context_distinct_id("ctx-user")
        context(analytics).capture("event", {"a": 1})

    assert len(adapter.captured) == 1
    assert adapter.captured[0].distinct_id == "ctx-user"


def test_view_explicit_distinct_id_overrides_context() -> None:
    adapter = _RecordingAdapter()
    analytics = Analytics(adapter)

    with new_context():
        set_context_distinct_id("ctx-user")
        context(analytics).capture("event", distinct_id="explicit-user")

    assert adapter.captured[0].distinct_id == "explicit-user"


def test_view_explicit_distinct_id_works_with_no_context() -> None:
    adapter = _RecordingAdapter()
    analytics = Analytics(adapter)

    context(analytics).capture("event", distinct_id="explicit-user")

    assert adapter.captured[0].distinct_id == "explicit-user"


def test_view_raises_when_no_context_and_no_explicit_distinct_id() -> None:
    adapter = _RecordingAdapter()
    analytics = Analytics(adapter)

    with pytest.raises(ValueError, match="no active analytics context and no explicit distinct_id"):
        context(analytics).capture("event")

    # Raised BEFORE any capture — no silent no-identity event, no personless fallback.
    assert adapter.captured == []


def test_view_raises_when_context_open_but_has_no_distinct_id() -> None:
    adapter = _RecordingAdapter()
    analytics = Analytics(adapter)

    with new_context():
        add_tag("t", "v")  # a context with tags but no identity
        with pytest.raises(ValueError, match="no explicit distinct_id"):
            context(analytics).capture("event")

    assert adapter.captured == []


def test_view_passes_dedupe_id_through_to_provider() -> None:
    adapter = _RecordingAdapter()
    analytics = Analytics(adapter)

    context(analytics).capture("event", distinct_id="u1", dedupe_id="fixed-id")

    assert adapter.captured[0].dedupe_id == "fixed-id"


# --- context(analytics): tag merge + three-tier precedence -------------------------------


def test_view_merges_context_tags_into_properties() -> None:
    adapter = _RecordingAdapter()
    analytics = Analytics(adapter)

    with new_context():
        set_context_distinct_id("u1")
        add_tag("request_id", "r1")
        context(analytics).capture("event", {"clicked": True})

    props = adapter.captured[0].properties
    assert props is not None
    assert props["request_id"] == "r1"
    assert props["clicked"] is True


def test_call_time_property_wins_over_context_tag_on_collision() -> None:
    adapter = _RecordingAdapter()
    analytics = Analytics(adapter)

    with new_context():
        set_context_distinct_id("u1")
        add_tag("k", "from-tag")
        context(analytics).capture("event", {"k": "from-call"})

    props = adapter.captured[0].properties
    assert props is not None
    assert props["k"] == "from-call"


def test_full_precedence_super_then_tag_then_call() -> None:
    # The three-tier order super_properties -> tags -> call_properties is a COMPOSITION: the
    # binding merges tags+call, the unmodified provider prepends its super-properties.
    adapter = _RecordingAdapter()
    analytics = Analytics(adapter, super_properties={"k": "from-super", "s": "super-only"})

    with new_context():
        set_context_distinct_id("u1")
        add_tag("k", "from-tag")
        add_tag("t", "tag-only")
        context(analytics).capture("event", {"k": "from-call", "c": "call-only"})

    props = adapter.captured[0].properties
    assert props is not None
    assert props["k"] == "from-call"  # call wins over tag wins over super
    assert props["t"] == "tag-only"
    assert props["c"] == "call-only"
    assert props["s"] == "super-only"


# --- context(analytics): tags cross the UNMODIFIED gate + validator ----------------------


def test_off_list_tag_raises_under_throw_policy() -> None:
    adapter = _RecordingAdapter()
    analytics = Analytics(
        adapter,
        allowlist=frozenset({"on_list"}),
        on_violation="throw",
    )

    with new_context():
        set_context_distinct_id("u1")
        add_tag("off_list", "leaked")
        with pytest.raises(ValueError, match="payload allowlist"):
            context(analytics).capture("event", {"on_list": 1})

    # The off-list tag was gated by the UNMODIFIED provider — no event reached the adapter.
    assert adapter.captured == []


def test_off_list_tag_drops_and_logs_under_drop_policy(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter = _RecordingAdapter()
    analytics = Analytics(
        adapter,
        allowlist=frozenset({"on_list"}),
        on_violation="drop-and-error-log",
    )

    with new_context():
        set_context_distinct_id("u1")
        add_tag("off_list", "leaked")
        with caplog.at_level(logging.ERROR, logger="analytics_kit"):
            context(analytics).capture("event", {"on_list": 1})

    assert adapter.captured == []
    assert any("off_list" in record.message for record in caplog.records)


def test_on_list_tag_passes_the_gate() -> None:
    adapter = _RecordingAdapter()
    analytics = Analytics(
        adapter,
        allowlist=frozenset({"request_id"}),
        on_violation="throw",
    )

    with new_context():
        set_context_distinct_id("u1")
        add_tag("request_id", "r1")
        context(analytics).capture("event", {"request_id": "r1"})

    assert len(adapter.captured) == 1


def test_taxonomy_typed_tag_with_wrong_type_is_caught_by_validator() -> None:
    taxonomy = define_taxonomy({"events": {"event": {"seats": "number"}}})
    adapter = _RecordingAdapter()
    analytics = Analytics(adapter, on_violation="throw", taxonomy=taxonomy)

    with new_context():
        set_context_distinct_id("u1")
        add_tag("seats", "not-a-number")  # a tag whose key is a declared taxonomy prop
        with pytest.raises(ValueError, match='expected type "number"'):
            context(analytics).capture("event")

    assert adapter.captured == []


# --- the free-function shape: the frozen provider surface is untouched -------------------


def test_analytics_gained_no_context_or_capture_in_context_member() -> None:
    adapter = _RecordingAdapter()
    analytics = Analytics(adapter)

    assert not hasattr(analytics, "context")
    assert not hasattr(analytics, "capture_in_context")
    assert not hasattr(Analytics, "context")
    assert not hasattr(Analytics, "capture_in_context")


def test_capture_signature_on_provider_still_requires_distinct_id() -> None:
    import inspect

    params = list(inspect.signature(Analytics.capture).parameters)
    # distinct_id remains a required positional on the shipped provider (Option B).
    assert params[:3] == ["self", "distinct_id", "event"]
