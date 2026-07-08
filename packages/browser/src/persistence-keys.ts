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
// CLIENT_SESSION_PROPS (persisted + `exposure: 'hidden'`); listed in RESERVED_EVENT_KEYS
// below so the super-prop merge excludes it.
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

// The [WIRE] event names for pageview / pageleave — the ONLY place the `$`-prefixed
// vendor tokens live. The wire-mapper emits PAGEVIEW_WIRE_EVENT for an event carrying
// the neutral `isPageView` marker (the router path stays in the neutral `event` name),
// and PAGELEAVE_WIRE_EVENT for the adapter-internal `pageleave`. Never on the neutral
// surface — the mapper is the boundary that swaps the neutral name/marker for these.
export const PAGEVIEW_WIRE_EVENT = '$pageview';
export const PAGELEAVE_WIRE_EVENT = '$pageleave';

// The [WIRE] property name that signals the backend to skip its server-side GeoIP
// (de-branded from posthog-core's $geoip_disable). Stamped into the wire event's
// properties by the wire-mapper when the library-set disableGeoip toggle is on. A
// library toggle, never a consumer value — the neutral surface never sees this token.
export const GEOIP_DISABLE_WIRE_KEY = '$geoip_disable';

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

// The library-computed / identity keys that share the property store with
// consumer-registered super-props. They are stamped by the library (or are wire
// state) — never consumer-supplied — so the super-prop merge-into-events must
// exclude them. Distinct from COOKIE_MIRRORED_KEYS ("mirror to the cookie?"):
// this answers "expose on events?", and the two lists will diverge as E6 adds
// event-visible enrichment keys that are not cookie-mirrored.
export const RESERVED_EVENT_KEYS: ReadonlySet<string> = new Set([
  DISTINCT_ID_KEY,
  DEVICE_ID_KEY,
  SESSION_ID_KEY,
  ANONYMOUS_DISTINCT_ID_KEY,
  IDENTITY_STATE_KEY,
  // The raw session-entry snapshot: persisted (survives reload) but NOT a consumer
  // super-prop — the derived `session_entry_*` keys are event-visible, this blob is not.
  // First of the "will diverge" enrichment keys the comment above anticipated.
  SESSION_ENTRY_PROPS_KEY,
]);

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
