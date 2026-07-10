"""Capability-port sketches — declared slots, not frozen contracts.

The method surface stays loose until a real flag/replay adapter first implements one.
Declaring the slots now means the feature-flags cycle fills a pre-declared port rather
than widening the seam. Both are type-only this release — always ``None`` on the seam.
"""

from __future__ import annotations

from typing import Protocol


class FeatureFlagPort(Protocol):
    """Sketch of the feature-flag capability slot."""

    def get_flag(self, key: str) -> object:
        """Resolve a feature flag by key."""
        ...


class SessionReplayPort(Protocol):
    """Sketch of the session-replay capability slot."""

    def start(self) -> None:
        """Begin a replay session."""
        ...
