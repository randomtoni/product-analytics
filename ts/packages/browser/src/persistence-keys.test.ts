import { describe, expect, test } from 'vitest';
import {
  ANONYMOUS_DISTINCT_ID_KEY,
  DEVICE_ID_KEY,
  DISTINCT_ID_KEY,
  GROUPS_KEY,
  IDENTITY_STATE_KEY,
  internalKeyPolicy,
  RESERVED_INTERNAL_PREFIX,
  SESSION_ENTRY_PROPS_KEY,
  SESSION_ID_KEY,
} from './persistence-keys';

describe('internalKeyPolicy — structural per-key exposure (FIX #3 + #9)', () => {
  test('the reserved internal prefix is neutral (no vendor $-sigil or token)', () => {
    expect(RESERVED_INTERNAL_PREFIX).toBe('__ak_');
    expect(RESERVED_INTERNAL_PREFIX).not.toContain('$');
  });

  test('the membership super-prop key is reserved-prefixed and classified `event` (rides + wire-renamed)', () => {
    expect(GROUPS_KEY.startsWith(RESERVED_INTERNAL_PREFIX)).toBe(true);
    expect(internalKeyPolicy(GROUPS_KEY)).toBe('event');
  });

  test('FAIL-SAFE: an UNCLASSIFIED reserved-prefix key defaults to `hidden` (inverts the old fail-open denylist)', () => {
    // A brand-new internal super-prop added under the reserved prefix but with NO explicit policy
    // entry stays OFF the wire by default — the #9 fix. The old RESERVED_EVENT_KEYS denylist was
    // fail-OPEN (a new internal key with no entry rode the wire); this is fail-SAFE.
    expect(internalKeyPolicy('__ak_some_future_internal')).toBe('hidden');
    expect(internalKeyPolicy(`${RESERVED_INTERNAL_PREFIX}anything`)).toBe('hidden');
  });

  test('the 5 legacy identity/session keys are `hidden` under their CURRENT (unprefixed) names', () => {
    // These are NOT renamed to the prefix — doing so would change the persisted cookie/localStorage
    // key names and break reload identity continuity. They stay hidden explicitly.
    for (const key of [
      DISTINCT_ID_KEY,
      DEVICE_ID_KEY,
      SESSION_ID_KEY,
      ANONYMOUS_DISTINCT_ID_KEY,
      IDENTITY_STATE_KEY,
    ]) {
      expect(key.startsWith(RESERVED_INTERNAL_PREFIX)).toBe(false);
      expect(internalKeyPolicy(key)).toBe('hidden');
    }
  });

  test('the raw session-entry snapshot key is `hidden` under its current (unprefixed) name', () => {
    // Persisted like the identity keys (survives a mid-session reload), so it also cannot be
    // renamed — same reload-compat reason. Only the derived session_entry_* keys ride events.
    expect(SESSION_ENTRY_PROPS_KEY.startsWith(RESERVED_INTERNAL_PREFIX)).toBe(false);
    expect(internalKeyPolicy(SESSION_ENTRY_PROPS_KEY)).toBe('hidden');
  });

  test('a plain consumer key is undefined (not internal — rides events untouched)', () => {
    expect(internalKeyPolicy('plan')).toBeUndefined();
    // The #3 crux: a consumer key literally named `groups` is NOT internal (no reserved prefix).
    expect(internalKeyPolicy('groups')).toBeUndefined();
    expect(internalKeyPolicy('country')).toBeUndefined();
  });
});
