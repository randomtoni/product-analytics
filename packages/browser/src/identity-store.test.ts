import { describe, expect, test } from 'vitest';
import { IdentityStore } from './identity-store';
import { PersistenceStore } from './persistence-store';
import { createMemoryBackend } from './storage-backends';
import {
  ANONYMOUS_DISTINCT_ID_KEY,
  DEVICE_ID_KEY,
  DISTINCT_ID_KEY,
  IDENTITY_STATE_KEY,
} from './persistence-keys';

let nameSeq = 0;
function freshStore(): PersistenceStore {
  nameSeq += 1;
  return new PersistenceStore({ backend: createMemoryBackend(), name: `identity-${nameSeq}` });
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('mints a UUIDv7 anonymous distinct id at first load and persists it', () => {
  const store = freshStore();
  const identity = new IdentityStore({ store });

  const id = identity.getDistinctId();
  expect(id).toMatch(UUID_V7);
  expect(store.getProperty(DISTINCT_ID_KEY)).toBe(id);
});

test('reuses the persisted distinct id across a reconstruct (same backing store)', () => {
  const store = freshStore();
  const first = new IdentityStore({ store }).getDistinctId();

  const second = new IdentityStore({ store }).getDistinctId();

  expect(second).toBe(first);
});

test('mints a device id under its OWN key, separate from the distinct id', () => {
  const store = freshStore();
  const identity = new IdentityStore({ store });

  const deviceId = store.getProperty<string>(DEVICE_ID_KEY);
  const distinctId = identity.getDistinctId();

  expect(deviceId).toMatch(UUID_V7);
  expect(store.getProperty(DEVICE_ID_KEY)).toBe(deviceId);
  expect(store.getProperty(DISTINCT_ID_KEY)).toBe(distinctId);
  // Two independently keyed identifiers — the distinct id is not stored under the
  // device-id key nor vice versa.
  expect(deviceId).not.toBeUndefined();
  expect(deviceId).not.toBe(distinctId);
});

test('the device id is minted once and reused across a reconstruct', () => {
  const store = freshStore();
  new IdentityStore({ store });
  const firstDeviceId = store.getProperty<string>(DEVICE_ID_KEY);

  new IdentityStore({ store });

  expect(store.getProperty(DEVICE_ID_KEY)).toBe(firstDeviceId);
});

test('getDistinctId reads the in-memory cache — no storage hit per call', () => {
  const store = freshStore();
  const identity = new IdentityStore({ store });
  let reads = 0;
  const original = store.getProperty.bind(store);
  store.getProperty = ((key: string) => {
    reads += 1;
    return original(key);
  }) as typeof store.getProperty;

  identity.getDistinctId();
  identity.getDistinctId();
  identity.getDistinctId();

  expect(reads).toBe(0);
});

test('models identity state as an explicit anonymous value at first load (no id-equality trick)', () => {
  const store = freshStore();
  const identity = new IdentityStore({ store });

  expect(identity.getIdentityState()).toBe('anonymous');
  expect(store.getProperty(IDENTITY_STATE_KEY)).toBe('anonymous');
});

test('a persisted identified state is honored on reconstruct (not overwritten to anonymous)', () => {
  const store = freshStore();
  new IdentityStore({ store });
  store.register({ [IDENTITY_STATE_KEY]: 'identified' });

  const reloaded = new IdentityStore({ store });

  expect(reloaded.getIdentityState()).toBe('identified');
});

test('an injected device-id generator swaps the id scheme without touching distinct-id semantics', () => {
  const store = freshStore();
  const identity = new IdentityStore({ store, deviceIdGenerator: () => 'device-scheme-x' });

  expect(store.getProperty(DEVICE_ID_KEY)).toBe('device-scheme-x');
  // The distinct id keeps the default UUIDv7 scheme — injecting a device-id
  // generator does not bleed into identity semantics.
  expect(identity.getDistinctId()).toMatch(UUID_V7);
  expect(identity.getDistinctId()).not.toBe('device-scheme-x');
});

describe('merge (S6 — anon→identified)', () => {
  test('swaps the cached + persisted distinct id in lockstep and flips state to identified', () => {
    const store = freshStore();
    const identity = new IdentityStore({ store });

    identity.merge('user-1');

    expect(identity.getDistinctId()).toBe('user-1');
    expect(store.getProperty(DISTINCT_ID_KEY)).toBe('user-1');
    expect(identity.getIdentityState()).toBe('identified');
    expect(store.getProperty(IDENTITY_STATE_KEY)).toBe('identified');
  });

  test('retains the prior anon id under ANONYMOUS_DISTINCT_ID_KEY and returns it (retain, not swap)', () => {
    const store = freshStore();
    const identity = new IdentityStore({ store });
    const anonId = identity.getDistinctId();

    const returned = identity.merge('user-1');

    expect(returned).toBe(anonId);
    expect(store.getProperty(ANONYMOUS_DISTINCT_ID_KEY)).toBe(anonId);
    // The device id is untouched by the merge (it is not the distinct id).
    expect(store.getProperty(DEVICE_ID_KEY)).not.toBe('user-1');
  });

  test('a merged identity is reused across a reconstruct (same backing store)', () => {
    const store = freshStore();
    const identity = new IdentityStore({ store });
    const anonId = identity.getDistinctId();
    identity.merge('user-1');

    const reloaded = new IdentityStore({ store });

    expect(reloaded.getDistinctId()).toBe('user-1');
    expect(reloaded.getIdentityState()).toBe('identified');
    expect(store.getProperty(ANONYMOUS_DISTINCT_ID_KEY)).toBe(anonId);
  });
});

describe('neutral-surface hygiene', () => {
  test('persists under de-branded keys — no $-prefixed name is written', () => {
    const store = freshStore();
    new IdentityStore({ store });

    for (const key of [DISTINCT_ID_KEY, DEVICE_ID_KEY, IDENTITY_STATE_KEY, ANONYMOUS_DISTINCT_ID_KEY]) {
      expect(key).not.toContain('$');
    }
    expect(store.getProperty(DISTINCT_ID_KEY)).toBeDefined();
    expect(store.getProperty(DEVICE_ID_KEY)).toBeDefined();
    expect(store.getProperty(IDENTITY_STATE_KEY)).toBe('anonymous');
  });
});
