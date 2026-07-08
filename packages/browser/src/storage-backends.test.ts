import { afterEach, describe, expect, test } from 'vitest';
import {
  buildPropsBackend,
  cookieBackend,
  createLocalStoragePlusCookieBackend,
  createMemoryBackend,
  DEFAULT_PERSISTENCE_MODE,
  localStorageBackend,
  type StorageBackend,
} from './storage-backends';
import { COOKIE_MIRRORED_KEYS } from './persistence-keys';

afterEach(() => {
  localStorage.clear();
  for (const cookie of document.cookie.split(';')) {
    const name = cookie.split('=')[0].trim();
    if (name) {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    }
  }
});

describe('cookieBackend', () => {
  test('set / parse round-trips a JSON blob', () => {
    cookieBackend.set('entry_a', { device_id: 'd1' });
    expect(cookieBackend.parse('entry_a')).toEqual({ device_id: 'd1' });
  });

  test('get returns the raw JSON string; parse returns null for a missing entry', () => {
    cookieBackend.set('entry_b', { x: 1 });
    expect(cookieBackend.get('entry_b')).toBe(JSON.stringify({ x: 1 }));
    expect(cookieBackend.parse('missing')).toBeNull();
  });

  test('remove deletes the entry', () => {
    cookieBackend.set('entry_c', { x: 1 });
    cookieBackend.remove('entry_c');
    expect(cookieBackend.parse('entry_c')).toBeNull();
  });
});

describe('localStorageBackend', () => {
  test('is supported under jsdom and round-trips a blob', () => {
    expect(localStorageBackend.isSupported()).toBe(true);
    localStorageBackend.set('entry_d', { device_id: 'd2' });
    expect(localStorageBackend.parse('entry_d')).toEqual({ device_id: 'd2' });
  });

  test('parse returns null for a missing entry', () => {
    expect(localStorageBackend.parse('nope')).toBeNull();
  });
});

describe('createMemoryBackend', () => {
  test('round-trips within an instance', () => {
    const memory = createMemoryBackend();
    memory.set('entry_e', { a: 1 });
    expect(memory.parse('entry_e')).toEqual({ a: 1 });
    expect(memory.get('entry_e')).toBe(JSON.stringify({ a: 1 }));
  });

  test('two instances are isolated — a write on one is invisible to the other', () => {
    const first = createMemoryBackend();
    const second = createMemoryBackend();
    first.set('entry_f', { a: 1 });
    expect(second.parse('entry_f')).toBeNull();
  });
});

describe('createLocalStoragePlusCookieBackend', () => {
  const name = 'combined_entry';

  test('the cookie half carries only the identity/session keys; localStorage holds the bulk', () => {
    const store = createLocalStoragePlusCookieBackend(COOKIE_MIRRORED_KEYS);

    store.set(name, { device_id: 'dev-1', report_count: 42, page_title: 'home' });

    // Cookie mirror is the identity subset only.
    expect(cookieBackend.parse(name)).toEqual({ device_id: 'dev-1' });
    // localStorage is the full blob (identity + bulk).
    expect(localStorageBackend.parse(name)).toEqual({
      device_id: 'dev-1',
      report_count: 42,
      page_title: 'home',
    });
  });

  test('no cookie is written when the blob carries no identity/session key', () => {
    const store = createLocalStoragePlusCookieBackend(COOKIE_MIRRORED_KEYS);

    store.set(name, { report_count: 7 });

    expect(cookieBackend.parse(name)).toBeNull();
    expect(localStorageBackend.parse(name)).toEqual({ report_count: 7 });
  });

  test('parse merges the two halves with localStorage winning on conflict', () => {
    const store = createLocalStoragePlusCookieBackend(COOKIE_MIRRORED_KEYS);
    localStorageBackend.set(name, { device_id: 'from-local', report_count: 1 });
    cookieBackend.set(name, { device_id: 'from-cookie' });

    expect(store.parse(name)).toEqual({ device_id: 'from-local', report_count: 1 });
  });

  test('parse returns null when neither half holds an entry', () => {
    const store = createLocalStoragePlusCookieBackend(COOKIE_MIRRORED_KEYS);
    expect(store.parse('never_written')).toBeNull();
  });
});

describe('buildPropsBackend', () => {
  test('the default mode is localStorage+cookie', () => {
    expect(DEFAULT_PERSISTENCE_MODE).toBe('localStorage+cookie');
  });

  test('memory mode returns the injected shared memory backend', () => {
    const memory = createMemoryBackend();
    const backend = buildPropsBackend('memory', memory);

    backend.set('entry_g', { a: 1 });

    // Same instance ⇒ a raw pre-store read on the shared memory sees the write.
    expect(memory.parse('entry_g')).toEqual({ a: 1 });
  });

  test('cookie mode writes to the cookie backend', () => {
    const backend = buildPropsBackend('cookie', createMemoryBackend());
    backend.set('entry_h', { device_id: 'd' });
    expect(cookieBackend.parse('entry_h')).toEqual({ device_id: 'd' });
  });

  test('localStorage+cookie mode splits identity keys into the cookie', () => {
    const backend = buildPropsBackend('localStorage+cookie', createMemoryBackend());
    backend.set('entry_i', { session_id: 's', report_count: 3 });
    expect(cookieBackend.parse('entry_i')).toEqual({ session_id: 's' });
    expect(localStorageBackend.parse('entry_i')).toEqual({ session_id: 's', report_count: 3 });
  });
});

describe('the raw-backend seam S3 reuses for a side-effect-free consent read', () => {
  test('a scalar can be written and read back through a raw backend without a property store', () => {
    const backend: StorageBackend = cookieBackend;
    const consentEntry = 'consent_decision';

    backend.set(consentEntry, 'granted');

    expect(JSON.parse(backend.get(consentEntry) as string)).toBe('granted');
  });

  test('reading a raw backend has no side effect on other entries', () => {
    localStorageBackend.set('other_entry', { a: 1 });
    localStorageBackend.get('absent_consent_entry');
    expect(localStorageBackend.parse('other_entry')).toEqual({ a: 1 });
  });
});
