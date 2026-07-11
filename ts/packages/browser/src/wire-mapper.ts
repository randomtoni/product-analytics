import type { NeutralEvent, NeutralProperties } from '@randomtoni/analytics-kit';
import {
  AUTOCAPTURE_WIRE_EVENT,
  GEOIP_DISABLE_WIRE_KEY,
  GROUP_IDENTIFY_WIRE_EVENT,
  GROUPS_KEY,
  GROUPS_WIRE_KEY,
  internalKeyPolicy,
  PAGELEAVE_WIRE_EVENT,
  PAGEVIEW_WIRE_EVENT,
  RESERVED_INTERNAL_PREFIX,
  SET_TRAITS_KEY,
  SET_TRAITS_ONCE_KEY,
  TOKEN_WIRE_KEY,
} from './persistence-keys';

// The [WIRE] shape of a single captured event — the object the transport POSTs
// (S2 wraps a `data:[]` array of these). Every key here is adapter-internal wire
// vocabulary; none of it appears on the neutral surface. Kept in one place so the
// wire vocabulary lives behind the adapter and a second backend adapter maps its
// own shape from the same NeutralEvent.
//
// - `uuid` is the top-level idempotency key: the value carried verbatim from the
//   neutral `dedupeId`. It is NOT `$insert_id` (a separate legacy random
//   browser-enrichment property that is not the dedup key and is never emitted
//   here). The neutral field name is `dedupeId` — the SAME name node (E7) exposes
//   for its own idempotency key — so client- and server-side retries dedupe on one
//   agreed value.
// - On a merge/traits event (recognized by the structural `internalKind === 'merge'`
//   discriminant, NOT the event name) the two person-trait bags are lifted OUT of
//   `properties` to the top-level `set_traits` / `set_traits_once` wire keys; the
//   retained prior anon id (`anonymous_distinct_id`) stays inside `properties`. All of
//   these are de-branded [WIRE] names, never neutral surface.
export interface WireEvent {
  event: string;
  distinct_id: string;
  // Already allowlist-filtered by the neutral pipeline upstream; the mapper is the last [WIRE] boundary, NOT a filtering point.
  properties?: NeutralProperties;
  timestamp?: string;
  uuid: string;
  set_traits?: NeutralProperties;
  set_traits_once?: NeutralProperties;
}

// Lay a NeutralEvent out into its [WIRE] shape. Value-agnostic on the id: it
// carries whatever `dedupeId` holds to the top-level `uuid` — it does NOT
// re-generate or re-version the id (the id is stamped once, at capture, then
// replayed unchanged across a retry, which is all dedupe requires).
//
// This is the single wire-mapper for the E5 transport. The pass-through mapping is
// the base every event takes; the merge/traits normalization (keyed off the
// structural `internalKind === 'merge'` discriminant the adapter mints — NOT the
// event name, so a consumer event named `identify` is never misrecognized) layers on
// top of it, lifting the trait bags to top-level wire keys.
// The adapter-internal, library-set wire toggles the mapper stamps onto the event.
// disableGeoip resolves once at adapter construction — never a consumer value, so it
// crosses no allowlist; it is applied here, at the [WIRE] boundary, not on the neutral
// surface. `token` is the ingest auth key threaded from config: stamped in-body on every
// event's properties (never a consumer value; the KEY VALUE is config, the wire property
// name is [WIRE] vocabulary) so the endpoint can authenticate each event.
export interface WireMapOptions {
  disableGeoip?: boolean;
  token?: string;
}

export function mapEventToWire(event: NeutralEvent, options?: WireMapOptions): WireEvent {
  const base: WireEvent = {
    event: wireEventName(event),
    distinct_id: event.distinctId,
    properties: event.properties,
    timestamp: event.timestamp?.toISOString(),
    uuid: event.dedupeId,
  };

  const mapped =
    event.internalKind !== 'merge' || event.properties === undefined
      ? base
      : normalizeMergeEvent(base, event.properties);

  return stampToken(
    stampGeoipDisable(applyInternalKeyPolicy(mapped), options?.disableGeoip),
    options?.token
  );
}

// The reserved-prefix internal keys that ride events ('event'-policy) and their [WIRE] target
// names. Only these are wire-renamed on the way out; a plain consumer key (policy undefined —
// e.g. a consumer property literally named `groups`) passes through UNTOUCHED. Keeping the
// wire-name mapping here (not on internalKeyPolicy) separates classification from wire
// vocabulary — the policy answers "does it ride?", this map answers "renamed to what?".
const EVENT_KEY_WIRE_NAME: ReadonlyMap<string, string> = new Map([[GROUPS_KEY, GROUPS_WIRE_KEY]]);

// Apply the FULL internalKeyPolicy to EVERY outgoing property — the wire-mapper sees the FINAL
// merged bag (super-prop store + per-event overrides), so it is the single point that can enforce
// the reserved-prefix boundary regardless of where a key entered. Structural, keyed off
// internalKeyPolicy:
//   'event'  → rename to its [WIRE] form (strips the reserved prefix): the library membership
//              super-prop __ak_groups → $groups, riding via the super-prop merge onto all events.
//   'hidden' AND reserved-prefix → STRIP: a reserved-prefix key (`__ak_`) is unambiguously
//              library-internal (a consumer never legitimately types one), so an unclassified /
//              hidden reserved-prefix key that reached the bag via a per-event property bag never
//              rides the wire. This is the privacy-boundary close: `track('x', { __ak_secret })`
//              cannot leak, and a consumer cannot forge `$groups` via a raw `__ak_groups` value
//              (unclassified is 'hidden' ⇒ stripped, never promoted).
//   otherwise (consumer key, incl. a legacy-hidden identity name like `distinct_id`) → pass through
//              UNTOUCHED. The strip is SCOPED to reserved-prefix keys on purpose: a consumer
//              property literally named `distinct_id` is legacy pre-existing behavior (it rides
//              today), so stripping it here would be an out-of-scope consumer-behavior change; a
//              consumer `groups` (no prefix ⇒ policy undefined) still rides as `groups` (#3 fix).
function applyInternalKeyPolicy(wire: WireEvent): WireEvent {
  if (wire.properties === undefined) {
    return wire;
  }
  const rest: NeutralProperties = {};
  const renamed: NeutralProperties = {};
  let changed = false;
  for (const [key, value] of Object.entries(wire.properties)) {
    const policy = internalKeyPolicy(key);
    if (policy === 'event') {
      const wireName = EVENT_KEY_WIRE_NAME.get(key);
      if (wireName !== undefined) {
        renamed[wireName] = value;
        changed = true;
        continue;
      }
    }
    if (policy === 'hidden' && key.startsWith(RESERVED_INTERNAL_PREFIX)) {
      changed = true;
      continue;
    }
    rest[key] = value;
  }
  if (!changed) {
    return wire;
  }
  return { ...wire, properties: { ...rest, ...renamed } };
}

// Stamp the [WIRE] $geoip_disable property when the library toggle is on. An event with
// no other properties still carries the flag (the properties bag is minted here if
// absent — mirrors posthog-core-stateless.ts:1168's undefined guard).
function stampGeoipDisable(wire: WireEvent, disableGeoip?: boolean): WireEvent {
  if (disableGeoip !== true) {
    return wire;
  }
  return { ...wire, properties: { ...wire.properties, [GEOIP_DISABLE_WIRE_KEY]: true } };
}

// Stamp the [WIRE] auth-key property on EVERY event (mirrors posthog-core.ts:1516's
// per-event properties['token'] set). Rides in-body so it survives gzip and the beacon
// path; the properties bag is minted here when the event has none. No token ⇒ no stamp
// (an unkeyed / no-delivery client).
function stampToken(wire: WireEvent, token?: string): WireEvent {
  if (token === undefined) {
    return wire;
  }
  return { ...wire, properties: { ...wire.properties, [TOKEN_WIRE_KEY]: token } };
}

// Swap the neutral event name/marker for its [WIRE] name. A pageview is recognized by
// the neutral `isPageView` marker (its `event` name is the router path, not a fixed
// token); the adapter-minted pageleave / autocapture / group-identify events by their
// structural `internalKind` discriminant (NOT the event name — a consumer event named
// `pageleave`/`autocapture`/`group_identify` under an untyped taxonomy keeps its own
// name, never misrenamed to the wire token). Every other event carries its neutral name
// through verbatim. The `$`-prefixed tokens live only here (+ their constants) — never on
// the neutral surface.
function wireEventName(event: NeutralEvent): string {
  if (event.isPageView === true) {
    return PAGEVIEW_WIRE_EVENT;
  }
  if (event.internalKind === 'pageleave') {
    return PAGELEAVE_WIRE_EVENT;
  }
  if (event.internalKind === 'autocapture') {
    return AUTOCAPTURE_WIRE_EVENT;
  }
  if (event.internalKind === 'group_identify') {
    return GROUP_IDENTIFY_WIRE_EVENT;
  }
  return event.event;
}

// Split the merge event's property bag: the two trait bags become top-level
// `set_traits` / `set_traits_once` wire keys; every other property (including the
// retained `anonymous_distinct_id` merge link) stays inside `properties`. An absent
// bag is omitted rather than emitted as an empty object.
function normalizeMergeEvent(base: WireEvent, properties: NeutralProperties): WireEvent {
  const rest: NeutralProperties = {};
  for (const [key, value] of Object.entries(properties)) {
    if (key === SET_TRAITS_KEY || key === SET_TRAITS_ONCE_KEY) {
      continue;
    }
    rest[key] = value;
  }

  const wire: WireEvent = {
    ...base,
    properties: Object.keys(rest).length > 0 ? rest : undefined,
  };
  if (SET_TRAITS_KEY in properties) {
    wire.set_traits = properties[SET_TRAITS_KEY] as NeutralProperties;
  }
  if (SET_TRAITS_ONCE_KEY in properties) {
    wire.set_traits_once = properties[SET_TRAITS_ONCE_KEY] as NeutralProperties;
  }
  return wire;
}

// Assemble the [WIRE] `data:[]` batch body from mapped wire events, applying the
// per-event `timestamp → offset` rewrite. `offset` is the millisecond age of the
// event relative to `now` (send time); the absolute `timestamp` is dropped in
// favour of the offset. An event with no timestamp carries no offset. This whole
// envelope shape is adapter-internal — it never reaches the neutral surface.
export function assembleBatchBody(wireEvents: WireEvent[], now: number): string {
  const data = wireEvents.map((wire) => rewriteTimestampToOffset(wire, now));
  return JSON.stringify({ data });
}

function rewriteTimestampToOffset(wire: WireEvent, now: number): Record<string, unknown> {
  const { timestamp, ...rest } = wire;
  if (timestamp === undefined) {
    return rest;
  }
  return { ...rest, offset: Math.abs(now - new Date(timestamp).getTime()) };
}
