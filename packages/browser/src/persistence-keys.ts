export const DISTINCT_ID_KEY = 'distinct_id';
export const DEVICE_ID_KEY = 'device_id';
export const SESSION_ID_KEY = 'session_id';
export const ANONYMOUS_DISTINCT_ID_KEY = 'anonymous_distinct_id';
export const IDENTITY_STATE_KEY = 'identity_state';

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

const STORE_NAME_PREFIX = 'analytics_kit';

export function storeName(key: string): string {
  return `${STORE_NAME_PREFIX}_${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}
