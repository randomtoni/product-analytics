"""Static-safety demo: a consumer-authored typed view catches bad calls at COMPILE time.

This is the DISTINCT positive concern (kept apart from the runtime-allowlist loud-failure demo):
Quillstream's ``cast``-applied typed view narrows the loose runtime provider so a bad event name
or a wrong-typed prop is a mypy error at compile time — the best-effort static layer from the
taxonomy recipe. The negative proofs live in the ``_reject_*`` functions below, which are
type-checked by mypy but NEVER called at runtime (so the bad runtime path never executes). Each
bad call is pinned with ``# type: ignore[call-overload]``: under the example's strict mypy
(``warn_unused_ignores`` on) the ignore is CONSUMED only because the call genuinely fails to
type-check — if the static layer ever regressed and stopped catching the bad call, the ignore
would become unused and the mypy gate would fail. So these lines are a real compile-time
assertion enforced by the gate, the Python analog of TS's ``@ts-expect-error``.

The cast is a runtime no-op: the positive path still records exactly like the plain provider.
"""

from __future__ import annotations

from quillstream import RecordingAdapter, create_quillstream_analytics
from quillstream.config import quillstream_config
from quillstream.typed_view import QuillstreamTypedAnalytics, create_typed_view_over


def _typed_view_and_recorder() -> tuple[QuillstreamTypedAnalytics, RecordingAdapter]:
    harness = create_quillstream_analytics(quillstream_config(key="k"))
    assert harness.recorder is not None
    return create_typed_view_over(harness.analytics), harness.recorder


def _reject_bad_event_name(typed: QuillstreamTypedAnalytics) -> None:
    # 'not_a_quillstream_event' is not a Literal of either overload -> [call-overload] at compile
    # time. mypy checks this (uncalled) body; the ignore is consumed by that error, and a
    # regression that stopped catching it would leave the ignore unused (the strict gate fails).
    typed.capture("user-1", "not_a_quillstream_event", {"plan": "pro", "seats": 5})  # type: ignore[call-overload]


def _reject_wrong_typed_prop(typed: QuillstreamTypedAnalytics) -> None:
    # `seats` is typed int on WorkspaceCreated; a string value fails the overload at compile time.
    typed.capture("user-1", "workspace_created", {"plan": "pro", "seats": "five"})  # type: ignore[call-overload]


def _reject_missing_required_prop(typed: QuillstreamTypedAnalytics) -> None:
    # WorkspaceCreated requires `seats`; omitting it fails the overload at compile time.
    typed.capture("user-1", "workspace_created", {"plan": "pro"})  # type: ignore[call-overload]


def test_typed_view_positive_path_type_checks_and_records() -> None:
    typed, recorder = _typed_view_and_recorder()

    # Correct event name + correctly-typed props: type-checks AND records (the cast is a no-op).
    typed.capture("user-1", "workspace_created", {"plan": "pro", "seats": 5})
    typed.capture("user-1", "document_created", {"document_id": "doc-1", "template": "blank"})

    assert [c.event for c in recorder.captures] == ["workspace_created", "document_created"]
    assert recorder.captures[0].properties is not None
    assert recorder.captures[0].properties["seats"] == 5


def test_negative_compile_time_proofs_are_defined_but_never_executed() -> None:
    # The compile-time proofs above are enforced by the strict mypy gate (the [call-overload]
    # ignores are consumed only if the bad calls genuinely fail to type-check). They are never
    # called at runtime — this test just pins that they are wired into the module so the gate
    # sees them. The type-safety guarantee is the mypy run, not this assertion.
    assert callable(_reject_bad_event_name)
    assert callable(_reject_wrong_typed_prop)
    assert callable(_reject_missing_required_prop)
