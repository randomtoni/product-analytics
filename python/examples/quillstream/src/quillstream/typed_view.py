"""Quillstream's consumer-authored typed view over the analytics provider — the static layer.

This is the DISTINCT static-safety concern (kept apart from the runtime-allowlist demo): the
library ships a loose runtime provider (``event: str``, ``properties: dict[str, object]``), and a
consumer who wants compile-time event-name + prop-shape checking hand-authors a view ``Protocol``
and applies it with :func:`cast` — a runtime no-op that mypy checks. This is the best-effort
static-typing recipe from ``analytics_kit.taxonomy`` (the const-generic wall means the library
cannot generate this map; the consumer mirrors the runtime ``.decl`` by hand).

Authored with TWO overloads so every static violation (bad event name / wrong-typed prop /
missing required prop) surfaces uniformly as ``[call-overload]``. The ``Literal`` names and
per-event ``TypedDict``\\ s below are Quillstream's own, mirroring its taxonomy.
"""

from __future__ import annotations

from typing import Literal, overload

from analytics_kit import Analytics
from analytics_kit.taxonomy import Protocol, TypedDict, cast


class WorkspaceCreated(TypedDict):
    plan: str
    seats: int


class DocumentCreated(TypedDict):
    document_id: str
    template: str


class QuillstreamTypedAnalytics(Protocol):
    """A statically-typed capture view over the two events Quillstream mirrors here."""

    @overload
    def capture(
        self,
        distinct_id: str,
        event: Literal["workspace_created"],
        properties: WorkspaceCreated,
        *,
        dedupe_id: str | None = ...,
    ) -> None: ...

    @overload
    def capture(
        self,
        distinct_id: str,
        event: Literal["document_created"],
        properties: DocumentCreated,
        *,
        dedupe_id: str | None = ...,
    ) -> None: ...


def create_typed_view_over(provider: Analytics) -> QuillstreamTypedAnalytics:
    """Narrow an existing provider to the typed view — the ``cast`` no-op, nothing else."""
    return cast(QuillstreamTypedAnalytics, provider)


__all__ = [
    "WorkspaceCreated",
    "DocumentCreated",
    "QuillstreamTypedAnalytics",
    "create_typed_view_over",
]
