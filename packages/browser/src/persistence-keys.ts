export const DISTINCT_ID_KEY = 'distinct_id';
export const DEVICE_ID_KEY = 'device_id';
export const SESSION_ID_KEY = 'session_id';
export const ANONYMOUS_DISTINCT_ID_KEY = 'anonymous_distinct_id';
export const IDENTITY_STATE_KEY = 'identity_state';

// The explicit neutral identity state persisted under IDENTITY_STATE_KEY. Modeled
// as a value (not the id-equality trick), and de-branded — no `$`-prefixed name.
export type IdentityState = 'anonymous' | 'identified';
export const ANONYMOUS_IDENTITY_STATE: IdentityState = 'anonymous';
export const IDENTIFIED_IDENTITY_STATE: IdentityState = 'identified';

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
]);

const STORE_NAME_PREFIX = 'analytics_kit';
const CONSENT_STORE_PREFIX = 'analytics_kit_consent';

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
