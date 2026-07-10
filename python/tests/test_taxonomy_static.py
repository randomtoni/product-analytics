"""mypy honesty tests for the best-effort static-typing layer — the Python analog of the TS
``@ts-expect-error`` type-pins in ``taxonomy.test.ts``.

These are type-level expectations mypy checks (``files=["src","tests"]`` in pyproject, with
``warn_unused_ignores`` on), NOT behavioural assertions — every ``# type: ignore`` below must
stay genuinely needed or the mypy gate fails. They prove BOTH halves of the guarantee:

- **What IS caught (best-effort static):** on a consumer-authored typed-view ``Protocol``
  (≥2 ``@overload``s of ``capture``, each ``event: Literal[...]`` + a per-event ``TypedDict``,
  applied via ``cast``), a bad event name / a wrong prop type / a missing required prop each
  error uniformly as ``[call-overload]``. Positives use ``assert_type``.
- **What is NOT caught (the honest gap):** the SAME wrong-typed prop call against the RAW
  runtime ``Analytics`` (not the cast view) produces NO mypy error — the runtime signature is
  ``dict[str, object]``, so static checking exists only where the consumer hand-declares. That
  silent raw call sits beside the erroring typed-view call as the executable proof.

``assert_type`` is imported from ``typing_extensions`` because the mypy target is
``python_version = "3.10"`` (pyproject), where ``typing.assert_type`` does not yet exist.
"""

from __future__ import annotations

from typing import Literal, overload

from typing_extensions import assert_type

from analytics_kit import Analytics, SingleEventCapture, create_analytics
from analytics_kit.taxonomy import Protocol, TypedDict, cast


class _SignedUp(TypedDict):
    plan: str
    seats: int


class _Checkout(TypedDict):
    total: int


class _TypedAnalytics(Protocol):
    """A consumer-authored typed VIEW — two overloads keeps every violation on ``[call-overload]``."""

    @overload
    def capture(
        self,
        distinct_id: str,
        event: Literal["signed_up"],
        properties: _SignedUp,
        *,
        dedupe_id: str | None = ...,
    ) -> None: ...
    @overload
    def capture(
        self,
        distinct_id: str,
        event: Literal["checkout"],
        properties: _Checkout,
        *,
        dedupe_id: str | None = ...,
    ) -> None: ...


def _what_is_caught() -> None:
    view = cast(_TypedAnalytics, create_analytics({}))

    # positives — the declared shape type-checks (assert_type pins the resolved return type)
    assert_type(view.capture("u1", "signed_up", {"plan": "pro", "seats": 3}), None)
    assert_type(view.capture("u1", "checkout", {"total": 5}), None)

    # negative: an undeclared event name — no overload variant matches
    view.capture("u1", "not_a_declared_event", {"plan": "pro", "seats": 3})  # type: ignore[call-overload]
    # negative: a wrong prop type (plan must be str, not int)
    view.capture("u1", "signed_up", {"plan": 3, "seats": 3})  # type: ignore[call-overload]
    # negative: a missing required prop (seats omitted)
    view.capture("u1", "signed_up", {"plan": "pro"})  # type: ignore[call-overload]


def _what_is_not_caught() -> None:
    # The RAW runtime provider — NOT the cast view. Its signature is loose
    # (event: str, properties: dict[str, object]), so the SAME wrong-typed call mypy flags on
    # the typed view is SILENT here. This is the honest gap: static checking exists only where
    # the consumer hand-declares a view. A stray `# type: ignore` here would fail the run under
    # warn_unused_ignores — its ABSENCE is the proof there is no error to suppress.
    raw = create_analytics({})
    assert_type(raw, Analytics)

    raw.capture("u1", "signed_up", {"plan": 3, "seats": "wrong"})  # no mypy error — the gap
    raw.capture("u1", "any_undeclared_event", {"whatever": object()})  # also silent


def _single_event_generic_convenience() -> None:
    # The optional boilerplate shorthand for a ONE-event view (not the mechanism). Binds
    # capture to a single event name + prop shape via one parametrization.
    view = cast(
        SingleEventCapture[Literal["signed_up"], _SignedUp],
        create_analytics({}),
    )

    assert_type(view.capture("u1", "signed_up", {"plan": "pro", "seats": 3}), None)

    # wrong prop type is caught (arg-type — this single-callable Protocol is not overloaded)
    view.capture("u1", "signed_up", {"plan": 3, "seats": 3})  # type: ignore[typeddict-item]
    # a non-matching event name is caught
    view.capture("u1", "checkout", {"plan": "pro", "seats": 3})  # type: ignore[arg-type]


def test_static_layer_module_is_type_checked() -> None:
    # A runtime anchor so pytest collects this module; the real assertions above are the mypy
    # gate (the ignores are consumed under warn_unused_ignores). Calling the helpers here would
    # hit create_analytics({}) with a no-op adapter — harmless — but the type layer is the point.
    assert callable(_what_is_caught)
    assert callable(_what_is_not_caught)
    assert callable(_single_event_generic_convenience)
