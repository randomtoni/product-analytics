"""The silent query no-op — a null object satisfying ``AnalyticsQueryClient``.

Selected by the factory when no personal key is set (or one is set but no endpoint), so
"unkeyed ⇒ queries nothing" is a null-object guarantee rather than a disabled flag threaded
through a client (bar B). Every primitive resolves to a well-formed empty :class:`QueryResult`
— a snapshot job in an unconfigured environment gets empty data, never an exception. No network
is ever touched; no adapter is constructed.

It satisfies the narrow :class:`AnalyticsQueryClient` structurally — NOT the wider seam
``AnalyticsAdapter``; the query client is a standalone read surface, so only the null-object
PATTERN is shared with the seam no-op.
"""

from __future__ import annotations

from datetime import datetime, timezone

from .client import (
    FunnelSpec,
    QueryResult,
    RetentionSpec,
    TrendSpec,
    UniqueCountSpec,
)


def _empty_result() -> QueryResult:
    return QueryResult(
        rows=[],
        columns=[],
        generated_at=datetime.now(timezone.utc).isoformat(),
    )


class QueryNoop:
    """A null-object query client: every primitive returns an empty result, nothing goes out."""

    def funnel(self, spec: FunnelSpec) -> QueryResult:
        """Query nothing — return an empty result."""
        return _empty_result()

    def retention(self, spec: RetentionSpec) -> QueryResult:
        """Query nothing — return an empty result."""
        return _empty_result()

    def trend(self, spec: TrendSpec) -> QueryResult:
        """Query nothing — return an empty result."""
        return _empty_result()

    def unique_count(self, spec: UniqueCountSpec) -> QueryResult:
        """Query nothing — return an empty result."""
        return _empty_result()

    def raw_query(self, expr: str) -> QueryResult:
        """Query nothing — return an empty result."""
        return _empty_result()
