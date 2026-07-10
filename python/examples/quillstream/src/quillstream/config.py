"""Quillstream's own analytics configuration — supplied entirely by the product.

The ingest ``AnalyticsConfig`` and the read-side ``QueryClientConfig`` are both consumer
values: Quillstream picks its super-properties, its allowlist contents (derived from its own
taxonomy plus the super-property keys it emits), its violation policy, and its query endpoint.
None of these live in the library.
"""

from __future__ import annotations

from analytics_kit import (
    AnalyticsConfig,
    QueryClientConfig,
    derive_allowlist_from_taxonomy,
)

from .taxonomy import quillstream_taxonomy

SUPER_PROPERTIES: dict[str, object] = {
    "app": "quillstream",
    "environment": "production",
}

# Request-scoped tags cross the same allowlist gate as any property, so the product allows them explicitly.
REQUEST_TAGS: tuple[str, ...] = ("request_id",)


def quillstream_config(key: str | None = None) -> AnalyticsConfig:
    """Quillstream's ingest config. Passing no ``key`` yields the unkeyed (no-op) posture."""
    return AnalyticsConfig(
        key=key,
        super_properties=SUPER_PROPERTIES,
        allowlist=[
            *derive_allowlist_from_taxonomy(quillstream_taxonomy),
            *SUPER_PROPERTIES.keys(),
            *REQUEST_TAGS,
        ],
        on_violation="throw",
        taxonomy=quillstream_taxonomy,
    )


def quillstream_query_config(personal_key: str | None = None) -> QueryClientConfig:
    """Quillstream's read-side query config — a distinct credential from the ingest key."""
    return QueryClientConfig(
        personal_key=personal_key,
        query_endpoint="https://analytics.quillstream.example/query",
        project_id="quillstream-prod",
        taxonomy=quillstream_taxonomy,
    )
