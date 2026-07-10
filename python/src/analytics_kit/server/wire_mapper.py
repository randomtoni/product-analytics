"""The adapter-internal wire-mapper — ``NeutralEvent`` to the server batch-message shape.

The provider mints, gates, and types every event; this maps each already-minted
:class:`~analytics_kit.NeutralEvent` onto the server's own de-branded wire shape. Every wire
token lives in a module-level ``_WIRE_*`` constant, confined to this module — none of it
appears on the neutral ``AnalyticsAdapter``/``NeutralEvent`` surface (the neutrality-scan
asserts this confinement).

The neutral ``dedupe_id`` lands on the wire top-level ``uuid`` verbatim (NOT ``$insert_id`` —
that is a browser-only random enrichment property, never the server dedup key). The trait and
group updates are recognized by the STRUCTURAL ``internal_kind`` discriminant the provider mints
them with, NEVER by the event name — so a consumer event literally named ``set_traits`` (with
``internal_kind is None``) is a plain pass-through, its own properties intact.
"""

from __future__ import annotations

from ..neutral_event import NeutralEvent, NeutralProperties

WireEvent = dict[str, object]
"""The wire shape of one server-side captured event — every key adapter-internal (a ``_WIRE_*``
constant). Built as a plain dict so the wire tokens stay confined to the constants below."""

WireBatchEnvelope = dict[str, object]
"""The batch envelope POSTed to the ingest endpoint — ``{api_key, batch, sent_at}``."""

# Wire top-level structural keys — the neutral event's fields, renamed onto the wire.
_WIRE_EVENT_KEY = "event"
_WIRE_DISTINCT_ID_KEY = "distinct_id"
_WIRE_PROPERTIES_KEY = "properties"
_WIRE_TIMESTAMP_KEY = "timestamp"

# Wire top-level idempotency key: the neutral ``dedupe_id`` carried here verbatim. NOT
# ``$insert_id`` (a browser-only random enrichment property, never emitted server-side).
_WIRE_UUID_KEY = "uuid"

# De-branded person-trait wire keys. Nested inside wire ``properties`` (the server shape — the
# browser target lifts them to the top level, the server does not). The provider stashes the raw
# bag under the SAME neutral wrapper key (``set``/``set_once``), so the read side and the emit
# side share one token.
_WIRE_SET_KEY = "set"
_WIRE_SET_ONCE_KEY = "set_once"

# De-branded group-identify wire keys, nested inside wire ``properties`` — NOT a separate
# per-event group-attribution shape (a mechanism the neutral surface does not expose this cycle).
_WIRE_GROUP_TYPE_KEY = "group_type"
_WIRE_GROUP_KEY_KEY = "group_key"
_WIRE_GROUP_SET_KEY = "group_set"

# Batch envelope keys POSTed to the ingest endpoint.
_WIRE_API_KEY = "api_key"
_WIRE_BATCH_KEY = "batch"
_WIRE_SENT_AT_KEY = "sent_at"


def map_event_to_wire(event: NeutralEvent) -> WireEvent:
    """Map one already-minted ``NeutralEvent`` onto the wire event shape.

    The ``dedupe_id`` lands on the top-level ``uuid`` verbatim; ``distinct_id``/``event`` carry
    through. ``properties`` and ``timestamp`` are emitted only when present. Trait/group events
    (recognized by ``internal_kind``, never the name) have their ``properties`` normalized to
    the nested wire wrapper keys; every other event is a plain pass-through.
    """
    wire: WireEvent = {
        _WIRE_UUID_KEY: event.dedupe_id,
        _WIRE_EVENT_KEY: event.event,
        _WIRE_DISTINCT_ID_KEY: event.distinct_id,
    }
    if event.timestamp is not None:
        wire[_WIRE_TIMESTAMP_KEY] = event.timestamp.isoformat()

    if event.internal_kind == "set_traits":
        wire[_WIRE_PROPERTIES_KEY] = _map_trait_properties(event.properties)
    elif event.internal_kind == "set_group_traits":
        wire[_WIRE_PROPERTIES_KEY] = _map_group_properties(event.properties)
    elif event.properties is not None:
        wire[_WIRE_PROPERTIES_KEY] = event.properties

    return wire


def _map_trait_properties(properties: NeutralProperties | None) -> NeutralProperties:
    """Rename the present trait wrapper key onto its nested wire key.

    The provider mints exactly ONE of ``set``/``set_once`` (never both), so only the present
    bag is emitted — each read guarded by an ``in`` check. An absent bag is never synthesized.
    """
    props = properties or {}
    wire: NeutralProperties = {}
    if _WIRE_SET_KEY in props:
        wire[_WIRE_SET_KEY] = props[_WIRE_SET_KEY]
    if _WIRE_SET_ONCE_KEY in props:
        wire[_WIRE_SET_ONCE_KEY] = props[_WIRE_SET_ONCE_KEY]
    return wire


def _map_group_properties(properties: NeutralProperties | None) -> NeutralProperties:
    """Rename the group wrapper keys onto their nested wire keys (each ``in``-guarded)."""
    props = properties or {}
    wire: NeutralProperties = {}
    if _WIRE_GROUP_TYPE_KEY in props:
        wire[_WIRE_GROUP_TYPE_KEY] = props[_WIRE_GROUP_TYPE_KEY]
    if _WIRE_GROUP_KEY_KEY in props:
        wire[_WIRE_GROUP_KEY_KEY] = props[_WIRE_GROUP_KEY_KEY]
    if _WIRE_GROUP_SET_KEY in props:
        wire[_WIRE_GROUP_SET_KEY] = props[_WIRE_GROUP_SET_KEY]
    return wire


def assemble_batch_envelope(
    api_key: str, events: list[NeutralEvent], sent_at: str
) -> WireBatchEnvelope:
    """Wrap mapped events in the ``{api_key, batch, sent_at}`` batch envelope."""
    return {
        _WIRE_API_KEY: api_key,
        _WIRE_BATCH_KEY: [map_event_to_wire(event) for event in events],
        _WIRE_SENT_AT_KEY: sent_at,
    }
