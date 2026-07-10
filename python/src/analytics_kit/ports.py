"""The neutral capability ports — the feature-flag port and the session-replay sketch.

The feature-flag port is the parity mirror of the TypeScript ``FeatureFlagPort``: one
load-bearing ``evaluate`` resolving an immutable :class:`FlagSet` snapshot read synchronously,
plus an ``on_change`` change-listener. ``evaluate`` is **synchronous by design** — it returns a
BARE :class:`FlagSet`, NOT a coroutine — even though the TS side returns ``Promise[FlagSet]``.
That is the honest per-language parity call (the PY5 query precedent): parity is the same
capability + the same snapshot-read contract, NOT the same async keyword. The blocking round-trip
lives inside the server adapter (E12-S4) as a blocking call, exactly as the HTTP query adapter
hides its POST/poll behind a blocking ``time.sleep``. A coroutine here would introduce the FIRST
asyncio surface in the Python tree, contradicting the locked no-asyncio posture for zero parity
gain. ``ports.py`` is deliberately outside ``test_sync_seam.py``'s seam fence, so a sync
``evaluate`` trips nothing.

The session-replay port stays a sketch — its method surface is loose until a real adapter first
implements one. Both ports are ``None`` on the seam this release (no adapter is wired here).
"""

from __future__ import annotations

from typing import Callable, Protocol, TypedDict

from .neutral_event import NeutralProperties

FlagValue = str | bool
"""A resolved flag's value — a variant string, or a plain on/off boolean."""

FlagReason = str
"""The consumer-observable state of a resolved flag read — the neutral degradation signal.

Named by state, never by any vendor eval-quality field. One of ``"resolved"`` (evaluated fresh
from the round-trip), ``"bootstrap"`` (served from config bootstrap before any fetch resolved),
``"stale"`` (a prior cached set served after a failed refresh), or ``"unresolved"`` (no value
available — failed with no fallback). Frozen here as the ONE union the adapters bind to; Python
expresses it as a ``str`` alias (the runtime-registry + best-effort-static ceiling PY3 locked)
rather than a compile-time literal union.
"""


class FlagContext(TypedDict, total=False):
    """The one neutral evaluation input: who is being evaluated and their describing properties.

    ``distinct_id`` is optional on the TYPE; the server adapter enforces its presence (no ambient
    actor — E12-S4). Control knobs (``refresh``) do NOT live here — they ride
    :class:`FlagEvaluateOptions`, so this stays pure "who + what properties".
    """

    distinct_id: str
    groups: dict[str, str]
    person_properties: NeutralProperties
    group_properties: dict[str, NeutralProperties]
    flag_keys: list[str]


class FlagEvaluateOptions(TypedDict, total=False):
    """Call-time control knobs for ``evaluate``, separate from the evaluation input.

    ``refresh`` folds the browser's ``reload`` into ``evaluate``: a caller forcing a re-fetch
    passes ``{"refresh": True}``. No separate ``reload`` method on the port.
    """

    refresh: bool


class FlagSet(Protocol):
    """An immutable resolved snapshot, read synchronously off ``evaluate``.

    ``degraded``/``reason`` are the neutral degradation signal — a consumer distinguishes "flag is
    off" from "eval failed / was partial". Vendor eval-quality metadata never reaches this type.
    """

    def is_enabled(self, key: str) -> bool:
        """Whether the flag is truthy (a variant string or ``True``)."""
        ...

    def get_flag(self, key: str) -> FlagValue | None:
        """The resolved value — a variant string, a boolean, or ``None`` when unresolved."""
        ...

    def get_payload(self, key: str) -> object:
        """The flag's payload, or ``None`` when there is none."""
        ...

    def get_all(self) -> dict[str, FlagValue]:
        """Every resolved flag as a key → value map."""
        ...

    @property
    def degraded(self) -> bool:
        """Whether this snapshot is degraded (eval failed or was partial)."""
        ...

    def reason(self, key: str) -> FlagReason | None:
        """The consumer-observable state for a key (see :data:`FlagReason`), or ``None``."""
        ...


class FeatureFlagPort(Protocol):
    """The neutral feature-flag capability port — parity mirror of the TS ``FeatureFlagPort``.

    ``evaluate`` resolves an immutable :class:`FlagSet` snapshot **synchronously** (not a
    coroutine — see the module docstring). ``on_change`` fires once with the resolved set on a
    server adapter and returns an unsubscribe callable — a uniform signature whose cardinality
    differs by target (the browser re-fires on reload).
    """

    def evaluate(
        self,
        context: FlagContext | None = None,
        options: FlagEvaluateOptions | None = None,
    ) -> FlagSet:
        """Resolve the current flag snapshot for ``context``. Synchronous, returns a bare snapshot."""
        ...

    def on_change(self, listener: Callable[[FlagSet], None]) -> Callable[[], None]:
        """Register a snapshot listener; returns an unsubscribe callable."""
        ...


class SessionReplayPort(Protocol):
    """Sketch of the session-replay capability slot."""

    def start(self) -> None:
        """Begin a replay session."""
        ...


class _EmptyFlagSet:
    """The canonical "nothing-resolved" snapshot — the Python analog of TS ``emptyFlagSet``.

    A real, structurally-complete :class:`FlagSet` a consumer can call safely (never a bare
    ``None`` that raises on ``.is_enabled(...)``). The null-object discipline applied to
    ``FlagSet``: it inhabits the contract with ``degraded=True``/``reason="unresolved"``/empty
    reads. Immutable — attribute assignment is blocked. Consumed by the server adapter's
    failed-round-trip fallback (E12-S4) and any Python consumer adopting without a flag adapter.
    """

    __slots__ = ()

    def is_enabled(self, key: str) -> bool:
        return False

    def get_flag(self, key: str) -> FlagValue | None:
        return None

    def get_payload(self, key: str) -> object:
        return None

    def get_all(self) -> dict[str, FlagValue]:
        return {}

    @property
    def degraded(self) -> bool:
        return True

    def reason(self, key: str) -> FlagReason | None:
        return "unresolved"

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError("empty_flag_set() is immutable")


_EMPTY_FLAG_SET = _EmptyFlagSet()


def empty_flag_set() -> FlagSet:
    """Return the canonical frozen "nothing-resolved" :class:`FlagSet` snapshot.

    Synchronous, ``degraded=True``, ``reason(...) == "unresolved"``, every read empty. A shared
    singleton — it holds no state, so one immutable instance serves all callers.
    """
    return _EMPTY_FLAG_SET
