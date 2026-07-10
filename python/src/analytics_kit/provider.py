"""The server-shaped provider — the consumer-facing verb surface.

The provider is the seam a consuming app codes against. Its verbs are baselined on the
server target (per-call ``distinct_id``, no persisted identity, no pageview surface), NOT a
browser facade. Every verb mints a :class:`~analytics_kit.NeutralEvent` and routes it
through the single ``adapter.capture(event)`` — there is no ``set``/``group`` adapter verb;
trait and group updates are discriminated ``NeutralEvent``\\ s (``internal_kind``) on the one
capture path.

Frozen-15 accounting — the fifteen members of the reference facade, each with its
server disposition (nine mapped verbs, four N-A-by-platform, two ``None`` capability slots):

===============  ==================================================================
Facade member    Server disposition
===============  ==================================================================
track            → ``capture(distinct_id, event, properties=None, *, dedupe_id=None)``
identify         → ``set(distinct_id, traits, once=False)`` (server person-props
                   update, NOT the anonymous→identified merge)
setTraits        → ``set(...)`` (same verb as identify; two members collapse to one)
group            → ``set_group_traits(group_type, group_key, traits)``
optIn            → ``opt_in()`` (instance send-switch, not a durable tri-state)
optOut           → ``opt_out()`` (drop-and-discard)
hasOptedOut      → ``has_opted_out()``
flush            → ``flush()`` (sync)
shutdown         → ``shutdown()`` (sync)
page             N-A by platform: no server pageview surface — documented, absent
reset            N-A by platform: no persisted server identity to re-anonymize
register         N-A as a runtime verb → construction-time ``super_properties`` dict
unregister       N-A as a runtime verb: no runtime super-property store server-side
flags            capability slot — ``FeatureFlagPort | None``, ``None`` this release
replay           capability slot — ``SessionReplayPort | None``, ``None`` this release
===============  ==================================================================

Consent is server-scoped: a single instance-level in-memory send switch. ``opt_out()`` sets
it, ``opt_in()`` clears it, ``has_opted_out()`` reads it; each verb short-circuits before
minting, dropping and discarding the event. A stateless server holds nothing to resurrect,
so the plain guard is the complete server semantic (there is no persisted store to protect
under opt-out).

Delivery posture (LOCKED) — the client is **synchronous with a background daemon thread**;
there is **no asyncio**. ``flush()`` and ``shutdown()`` are synchronous and
*drain-to-completion*: they block until the delegated ``adapter.flush()`` / ``adapter.shutdown()``
returns, never fire-and-forget, never a coroutine. The ``sync_mode`` config flag selects
delivery: ``sync_mode=True`` bypasses the thread and delivers inline (the mode short-lived
scripts and tests use); ``sync_mode=False`` (default) offloads delivery to the background
daemon thread. This module fixes the posture and the lifecycle contract only — the queue,
the daemon thread, the exit-time join, and the two ``sync_mode`` delivery paths are wired by
the server-capture cycle inside the target adapter, which plugs into the existing
``adapter.capture`` / ``adapter.flush`` / ``adapter.shutdown`` contract with no new seam member.
"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from .adapter import AnalyticsAdapter
from .allowlist import ViolationPolicy, enforce_allowlist
from .neutral_event import NeutralEvent, NeutralProperties, NeutralTraits
from .ports import FeatureFlagPort, SessionReplayPort

SET_TRAITS_EVENT = "set_traits"
SET_GROUP_TRAITS_EVENT = "set_group_traits"

SET_KEY = "set"
SET_ONCE_KEY = "set_once"
GROUP_TYPE_KEY = "group_type"
GROUP_KEY_KEY = "group_key"
GROUP_SET_KEY = "group_set"


class Analytics:
    """The server-shaped provider verb surface routed through a capture-only adapter."""

    flags: FeatureFlagPort | None = None
    replay: SessionReplayPort | None = None

    def __init__(
        self,
        adapter: AnalyticsAdapter,
        super_properties: NeutralProperties | None = None,
        *,
        allowlist: frozenset[str] | None = None,
        on_violation: ViolationPolicy = "throw",
    ) -> None:
        self._adapter = adapter
        self._super_properties = super_properties
        self._allowlist = allowlist
        self._on_violation = on_violation
        self._opted_out = False
        self.flags = None
        self.replay = None

    def capture(
        self,
        distinct_id: str,
        event: str,
        properties: NeutralProperties | None = None,
        *,
        dedupe_id: str | None = None,
    ) -> None:
        """Capture an event for ``distinct_id``, merging the construction-time super-properties."""
        if self._opted_out:
            return
        merged = self._merge_super_properties(properties)
        if not self._allowed(merged):
            return
        self._adapter.capture(
            NeutralEvent(
                event=event,
                distinct_id=distinct_id,
                dedupe_id=dedupe_id if dedupe_id is not None else str(uuid4()),
                properties=merged,
                timestamp=datetime.now(timezone.utc),
            )
        )

    def set(self, distinct_id: str, traits: NeutralTraits, once: bool = False) -> None:
        """Update person properties for ``distinct_id`` — the server person-props verb.

        ``once=True`` records first-touch traits (never overwritten later); ``once=False``
        overwrites. Super-properties are event-context enrichment and are NOT folded into the
        trait bag.
        """
        if self._opted_out:
            return
        if not self._allowed(traits):
            return
        key = SET_ONCE_KEY if once else SET_KEY
        self._adapter.capture(
            NeutralEvent(
                event=SET_TRAITS_EVENT,
                distinct_id=distinct_id,
                dedupe_id=str(uuid4()),
                properties={key: traits},
                timestamp=datetime.now(timezone.utc),
                internal_kind="set_traits",
            )
        )

    def set_group_traits(self, group_type: str, group_key: str, traits: NeutralTraits) -> None:
        """Update properties for a group. ``group_type``/``group_key`` are routing identifiers,
        not consumer properties; only ``traits`` carries consumer-supplied values."""
        if self._opted_out:
            return
        if not self._allowed(traits):
            return
        self._adapter.capture(
            NeutralEvent(
                event=SET_GROUP_TRAITS_EVENT,
                distinct_id=f"{group_type}_{group_key}",
                dedupe_id=str(uuid4()),
                properties={
                    GROUP_TYPE_KEY: group_type,
                    GROUP_KEY_KEY: group_key,
                    GROUP_SET_KEY: traits,
                },
                timestamp=datetime.now(timezone.utc),
                internal_kind="set_group_traits",
            )
        )

    def flush(self) -> None:
        """Force-send buffered events; leaves the provider usable afterward.

        Synchronous drain-to-completion: blocks until the delegated ``adapter.flush()``
        returns. Not fire-and-forget, not a coroutine.
        """
        self._adapter.flush()

    def shutdown(self) -> None:
        """Drain and quiesce for process exit.

        Synchronous drain-to-completion: blocks until the delegated ``adapter.shutdown()``
        returns. Not fire-and-forget, not a coroutine.
        """
        self._adapter.shutdown()

    def opt_out(self) -> None:
        """Set the instance send switch — subsequent verbs drop and discard their event."""
        self._opted_out = True

    def opt_in(self) -> None:
        """Clear the instance send switch — subsequent verbs deliver again."""
        self._opted_out = False

    def has_opted_out(self) -> bool:
        """Read the instance send switch."""
        return self._opted_out

    def _allowed(self, bag: NeutralProperties | None) -> bool:
        """Gate a consumer-supplied bag through the payload allowlist.

        Returns ``True`` to proceed and ``False`` to drop (the ``drop-and-error-log`` signal);
        under the ``throw`` policy an off-list key raises out of the verb before any mint.
        """
        return enforce_allowlist(self._allowlist, self._on_violation, bag)

    def _merge_super_properties(
        self, properties: NeutralProperties | None
    ) -> NeutralProperties | None:
        if not self._super_properties:
            return properties
        if properties is None:
            return dict(self._super_properties)
        return {**self._super_properties, **properties}
