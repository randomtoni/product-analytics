"""Quillstream's own analytics configuration — supplied entirely by the product.

The ingest ``AnalyticsConfig`` and the read-side ``QueryClientConfig`` are both consumer
values: Quillstream picks its super-properties, its allowlist contents (derived from its own
taxonomy plus the super-property keys it emits), its violation policy, and its query endpoint.
None of these live in the library.
"""

from __future__ import annotations

from analytics_kit import (
    AnalyticsConfig,
    FlagBootstrap,
    FlagClientConfig,
    FlagsConfig,
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

# The bootstrap flag set Quillstream renders server-side and seeds by config (bar B). Neutral field
# names (``flags``/``payloads``). Served as the round-trip fallback when a fresh eval fails.
FLAG_BOOTSTRAP = FlagBootstrap(
    flags={"ai_draft_assist": "concise", "bulk_publish": True},
    payloads={"ai_draft_assist": {"model": "draft-1", "max_tokens": 256}},
)


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


def quillstream_flag_config(
    key: str | None = None,
    flag_endpoint: str | None = "https://analytics.quillstream.example",
) -> FlagClientConfig:
    """Quillstream's standalone flag-eval config — a distinct credential + endpoint from ingest.

    Passing no ``key`` (or dropping ``flag_endpoint``) yields the no-op flag client (bar B — an
    unconfigured environment resolves nothing); a key + endpoint selects the real remote adapter.
    ``bootstrap`` seeds the fallback served when a round-trip fails.
    """
    return FlagClientConfig(
        key=key,
        flag_endpoint=flag_endpoint,
        bootstrap=FLAG_BOOTSTRAP,
        taxonomy=quillstream_taxonomy,
    )


def quillstream_config_with_flags(
    key: str | None = None,
    flag_endpoint: str | None = "https://analytics.quillstream.example",
) -> AnalyticsConfig:
    """Quillstream's ingest config with the ``flags`` slot set — the ``create_server_analytics``

    slot path (bar B): a keyed config plus ``flags.flag_endpoint`` attaches a flag client to the
    provider's ``flags`` slot by configuration alone. Dropping the endpoint leaves the slot unset.
    """
    config = quillstream_config(key)
    return config.model_copy(
        update={"flags": FlagsConfig(flag_endpoint=flag_endpoint, bootstrap=FLAG_BOOTSTRAP)}
    )
