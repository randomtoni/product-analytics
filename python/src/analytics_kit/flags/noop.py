"""The silent flag-client no-op — a null object satisfying ``FeatureFlagPort``.

Selected by the factory when no key is set (or one is set but no endpoint), so "unkeyed ⇒
resolves nothing" is a null-object guarantee rather than a disabled flag threaded through the
adapter (bar B). ``evaluate`` always returns the canonical ``empty_flag_set()`` (``degraded``,
every read empty) — an unconfigured environment gets a safe, structurally-complete snapshot,
never an exception, and no network is ever touched. ``on_change`` fires once with that empty set,
preserving the port's once-fire cardinality uniformly.
"""

from __future__ import annotations

from collections.abc import Callable

from ..ports import (
    FeatureFlagPort,
    FlagContext,
    FlagEvaluateOptions,
    FlagSet,
    empty_flag_set,
)


class FlagNoop:
    """A null-object flag client: every ``evaluate`` returns the empty snapshot, nothing goes out."""

    def evaluate(
        self,
        context: FlagContext | None = None,
        options: FlagEvaluateOptions | None = None,
    ) -> FlagSet:
        """Resolve nothing — return the canonical empty snapshot."""
        return empty_flag_set()

    def on_change(self, listener: Callable[[FlagSet], None]) -> Callable[[], None]:
        """Fire once with the empty snapshot (uniform once-fire cardinality); unsubscribe is inert."""
        listener(empty_flag_set())
        return lambda: None


_NOOP_CONFORMANCE: type[FeatureFlagPort] = FlagNoop
