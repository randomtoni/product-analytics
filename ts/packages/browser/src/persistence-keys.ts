export const DISTINCT_ID_KEY = 'distinct_id';
export const DEVICE_ID_KEY = 'device_id';
export const SESSION_ID_KEY = 'session_id';
export const ANONYMOUS_DISTINCT_ID_KEY = 'anonymous_distinct_id';
export const IDENTITY_STATE_KEY = 'identity_state';

// The persisted per-session entry snapshot: the raw `{ sessionId, referrer, url }` that
// the neutral `session_entry_*` props are DERIVED from, keyed by the session it was
// captured under so its lifespan equals the session id's (reset on rotation). Persisted
// (survives a reload within the same session) but NEVER event-visible as a raw super-prop
// — the derived `session_entry_*` keys are what ride events. De-branded from posthog's
// CLIENT_SESSION_PROPS (persisted + `exposure: 'hidden'`); classified 'hidden' via
// internalKeyPolicy below (LEGACY_HIDDEN_KEYS) so the super-prop merge excludes it.
export const SESSION_ENTRY_PROPS_KEY = 'session_entry_props';

// The explicit neutral identity state persisted under IDENTITY_STATE_KEY. Modeled
// as a value (not the id-equality trick), and de-branded — no `$`-prefixed name.
export type IdentityState = 'anonymous' | 'identified';
export const ANONYMOUS_IDENTITY_STATE: IdentityState = 'anonymous';
export const IDENTIFIED_IDENTITY_STATE: IdentityState = 'identified';

// The reserved event name for the anon→identified merge the adapter emits inside
// identify(). Adapter-internal wire vocabulary the consumer never types (unlike the
// neutral RESERVED_PAGE_EVENT) — the E5 wire-mapper maps it to the vendor merge
// event. De-branded — no `$`-prefixed name.
export const MERGE_EVENT = 'identify';

// The neutral event NAME of an autocaptured DOM interaction (click/change/submit),
// minted entirely inside the browser adapter — the consumer never types it (same
// adapter-internal posture as MERGE_EVENT, NOT a seam-reserved facade verb). The
// wire-mapper maps it to AUTOCAPTURE_WIRE_EVENT. De-branded from posthog's
// `$autocapture` — no `$`-prefixed name on the neutral surface.
export const AUTOCAPTURE_EVENT = 'autocapture';

// The [WIRE] event names for pageview / pageleave — the ONLY place the `$`-prefixed
// vendor tokens live. The wire-mapper emits PAGEVIEW_WIRE_EVENT for an event carrying
// the neutral `isPageView` marker (the router path stays in the neutral `event` name),
// and PAGELEAVE_WIRE_EVENT for the adapter-internal `pageleave`. Never on the neutral
// surface — the mapper is the boundary that swaps the neutral name/marker for these.
export const PAGEVIEW_WIRE_EVENT = '$pageview';
export const PAGELEAVE_WIRE_EVENT = '$pageleave';

// The [WIRE] event name for an autocaptured DOM interaction — the ONLY place the
// `$`-prefixed vendor token lives. The wire-mapper emits this for an event carrying the
// neutral AUTOCAPTURE_EVENT name. Never on the neutral surface.
export const AUTOCAPTURE_WIRE_EVENT = '$autocapture';

// The [WIRE] event name for a group-identify — the ONLY place this `$`-prefixed vendor
// token lives. The wire-mapper emits it for an event carrying the neutral
// GROUP_IDENTIFY_EVENT name. Never on the neutral surface.
export const GROUP_IDENTIFY_WIRE_EVENT = '$groupidentify';

// The [WIRE] property name the `groups` super-prop is renamed to on the way out (de-branded
// source: posthog's `$groups`). The wire-mapper swaps GROUPS_KEY → this on every event that
// carries the membership super-prop. The ONLY place this `$`-prefixed token lives.
export const GROUPS_WIRE_KEY = '$groups';

// The [WIRE] property name that signals the backend to skip its server-side GeoIP
// (de-branded from posthog-core's $geoip_disable). Stamped into the wire event's
// properties by the wire-mapper when the library-set disableGeoip toggle is on. A
// library toggle, never a consumer value — the neutral surface never sees this token.
export const GEOIP_DISABLE_WIRE_KEY = '$geoip_disable';

// The reserved NEUTRAL namespace prefix for library-internal super-props that share the
// property store with consumer-registered ones. Neutral — no vendor token (de-branded from
// posthog's `$` sigil). Its job is to keep the internal namespace DISJOINT from the consumer
// one: a consumer property named `groups` must not collide with the library's membership
// super-prop, and a new internal super-prop must be structurally recognizable without a
// hand-maintained denylist. Any key under this prefix is internal; its exposure follows the
// per-key policy below, defaulting to hidden (fail-safe) when unclassified.
export const RESERVED_INTERNAL_PREFIX = '__ak_';

// The internal super-prop key holding the actor's group memberships (`{ [groupType]:
// groupKey }`), registered by group() and merged onto every event via mergeSuperProperties
// (de-branded from posthog's `$groups` super-prop). Prefixed so a consumer property literally
// named `groups` can co-exist on the SAME event uncorrupted. It is MEANT to ride events, so its
// exposure policy is 'event' (see internalKeyPolicy) and the wire-mapper renames it to
// GROUPS_WIRE_KEY on the way out.
export const GROUPS_KEY = '__ak_groups';

// The adapter-internal event NAME group() mints to identify a group (register memberships +
// attach group traits), minted entirely inside the adapter — the consumer never types it
// (same posture as MERGE_EVENT / AUTOCAPTURE_EVENT). The wire-mapper maps it to
// GROUP_IDENTIFY_WIRE_EVENT. De-branded from posthog's `$groupidentify` — no `$`-prefix.
export const GROUP_IDENTIFY_EVENT = 'group_identify';

// The de-branded [WIRE] property key names carried on the group-identify event's properties
// (de-branded from posthog's `$group_type`/`$group_key`/`$group_set`). Matches node's
// wire-mapper group-key names for cross-target wire consistency. Nested inside `properties`
// on the browser wire (like posthog's $groupidentify), never lifted to a top-level field.
export const GROUP_TYPE_KEY = 'group_type';
export const GROUP_KEY_KEY = 'group_key';
export const GROUP_SET_KEY = 'group_set';

// The [WIRE] property name carrying the ingest auth key on EVERY event. The batch
// endpoint reads the key off each event's properties (de-branded from posthog-core,
// where calculateEventProperties sets properties['token'] per event) — NOT a top-level
// envelope field or a URL param — so it survives gzip on the normal POST and the beacon
// path alike. The KEY VALUE is consumer config; this is only the wire property name it
// rides under. Adapter-internal — the neutral surface never sees this token.
export const TOKEN_WIRE_KEY = 'token';

// Adapter-internal [WIRE] property names carried on the merge / traits event only —
// the retained prior anon id (the merge link) and the two person-trait bags. The
// E5 wire-mapper normalizes these to the vendor conventions; the neutral surface
// never sees a `$`-prefixed name.
export const SET_TRAITS_KEY = 'set_traits';
export const SET_TRAITS_ONCE_KEY = 'set_traits_once';

// The small identity/session keys that the cookie half mirrors so they can be
// shared across subdomains; the bulk of the props blob stays in localStorage.
// The value minters land in later slices (S5/S8) — this store only routes them.
export const COOKIE_MIRRORED_KEYS: readonly string[] = [
  DISTINCT_ID_KEY,
  DEVICE_ID_KEY,
  SESSION_ID_KEY,
  ANONYMOUS_DISTINCT_ID_KEY,
  IDENTITY_STATE_KEY,
];

// The exposure policy of a library-internal super-prop that shares the property store with
// consumer-registered ones: 'event' rides events (wire-renamed by the wire-mapper), 'hidden'
// never reaches events (identity/session/wire state, stamped elsewhere).
export type InternalKeyExposure = 'event' | 'hidden';

// The CLOSED legacy set of persisted-but-not-event-visible internal keys that predate the
// RESERVED_INTERNAL_PREFIX convention and CANNOT be renamed to adopt it: doing so would change
// the persisted cookie/localStorage key name and break reload identity/session continuity (a
// reload would read the old name, miss the stored value, and re-mint). So they keep their
// current names and are classified 'hidden' explicitly here. This set is closed for reload-compat
// reasons — every NEW internal super-prop must instead use RESERVED_INTERNAL_PREFIX and is caught
// structurally by internalKeyPolicy, so this list never grows stale the way a denylist would.
const LEGACY_HIDDEN_KEYS: ReadonlySet<string> = new Set([
  DISTINCT_ID_KEY,
  DEVICE_ID_KEY,
  SESSION_ID_KEY,
  ANONYMOUS_DISTINCT_ID_KEY,
  IDENTITY_STATE_KEY,
  // The raw session-entry snapshot: persisted (survives reload, keyed by session id) but NOT a
  // consumer super-prop — the derived `session_entry_*` keys are event-visible, this blob is not.
  // Persisted like the identity keys, so it CANNOT be renamed either — same reload-compat reason.
  SESSION_ENTRY_PROPS_KEY,
]);

// The explicit exposure policy for RESERVED_INTERNAL_PREFIX keys. A prefixed key NOT listed here
// defaults to 'hidden' (the fail-safe in internalKeyPolicy) — the inverse of the old fail-OPEN
// denylist, so a new internal super-prop added without a policy entry stays OFF the wire until
// deliberately classified 'event'.
const PREFIXED_KEY_EXPOSURE: ReadonlyMap<string, InternalKeyExposure> = new Map([
  [GROUPS_KEY, 'event'],
]);

// Classify a super-prop key for the merge-into-events pass. Returns 'event' (an internal key
// that rides events, wire-renamed), 'hidden' (an internal key stripped from events), or
// undefined (a plain consumer key — rides as-is, untouched). This structural rule replaces the
// hand-maintained RESERVED_EVENT_KEYS denylist: a prefixed key follows its explicit exposure,
// defaulting to 'hidden' (fail-safe) when unclassified; a legacy identity/session key is 'hidden';
// everything else is a consumer key. Callers: mergeSuperProperties strips iff 'hidden'; the
// wire-mapper renames iff 'event'.
export function internalKeyPolicy(key: string): InternalKeyExposure | undefined {
  if (key.startsWith(RESERVED_INTERNAL_PREFIX)) {
    return PREFIXED_KEY_EXPOSURE.get(key) ?? 'hidden';
  }
  if (LEGACY_HIDDEN_KEYS.has(key)) {
    return 'hidden';
  }
  return undefined;
}

const STORE_NAME_PREFIX = 'analytics_kit';
const CONSENT_STORE_PREFIX = 'analytics_kit_consent';
const QUEUE_STORE_PREFIX = 'analytics_kit_queue';

function sanitize(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function storeName(key: string): string {
  return `${STORE_NAME_PREFIX}_${sanitize(key)}`;
}

// The durable consent decision lives under its own top-level name — separate from
// the property store it gates — so it can be read side-effect-free before the
// property store is built.
export function consentStoreName(key: string): string {
  return `${CONSENT_STORE_PREFIX}_${sanitize(key)}`;
}

// The persisted offline transport buffer lives under its OWN top-level name —
// separate from both the property store and the consent decision. It is transport
// state (undelivered ingest batches mirrored so they survive a reload), never
// identity/super-props, so it must not share the property blob.
export function queueStoreName(key: string): string {
  return `${QUEUE_STORE_PREFIX}_${sanitize(key)}`;
}
