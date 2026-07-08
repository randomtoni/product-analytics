import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  buildPropsBackend,
  cookieBackend,
  createCookieBackend,
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

describe('createCookieBackend with a resolved domain', () => {
  // jsdom rejects a cookie whose domain= mismatches the current host (localhost),
  // so cross-origin domains are asserted at the write string via a setter spy;
  // domain=.localhost (host-matching) is used for a real round-trip.
  function withCookieWriteSpy(run: (writes: string[]) => void): void {
    const writes: string[] = [];
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    const spy = vi.spyOn(document, 'cookie', 'set').mockImplementation((value: string) => {
      writes.push(value);
    });
    try {
      run(writes);
    } finally {
      spy.mockRestore();
      if (descriptor) {
        Object.defineProperty(document, 'cookie', descriptor);
      }
    }
  }

  test('a configured domain is emitted as "; domain=.<d>" on every write', () => {
    const backend = createCookieBackend({ domain: 'example.com' });

    withCookieWriteSpy((writes) => {
      backend.set('id_entry', { distinct_id: 'u-1' });
      expect(writes.at(-1)).toContain('; domain=.example.com');
    });
  });

  test('the same domain is emitted on remove — a cookie is deleted at the scope it was set', () => {
    const backend = createCookieBackend({ domain: 'example.com' });

    withCookieWriteSpy((writes) => {
      backend.remove('id_entry');
      expect(writes.at(-1)).toContain('; domain=.example.com');
    });
  });

  test('no domain option ⇒ a host-only cookie, no domain= attribute', () => {
    const backend = createCookieBackend();

    withCookieWriteSpy((writes) => {
      backend.set('id_entry', { distinct_id: 'u-1' });
      expect(writes.at(-1)).not.toContain('domain=');
    });
  });

  test('a host-matching domain round-trips through jsdom (domain=.localhost is accepted)', () => {
    const backend = createCookieBackend({ domain: 'localhost' });

    backend.set('scoped_entry', { distinct_id: 'shared-across-subdomains' });

    expect(backend.parse('scoped_entry')).toEqual({ distinct_id: 'shared-across-subdomains' });
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

  test('a config cookieDomain is authoritative and threaded into the cookie write — probe never runs', () => {
    const before = document.cookie;
    const writes: string[] = [];
    const spy = vi.spyOn(document, 'cookie', 'set').mockImplementation((value: string) => {
      writes.push(value);
    });
    try {
      const backend = buildPropsBackend('cookie', createMemoryBackend(), {
        cookieDomain: 'example.com',
        crossSubdomainCookie: true,
      });
      backend.set('entry_domain', { device_id: 'd' });

      // The identity cookie is written at the configured domain...
      expect(writes.at(-1)).toContain('; domain=.example.com');
      // ...and no throwaway probe cookie was ever written (config authoritative).
      expect(writes.some((w) => w.includes('domain_probe_'))).toBe(false);
    } finally {
      spy.mockRestore();
      const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
      if (descriptor) {
        Object.defineProperty(document, 'cookie', descriptor);
      }
    }
    // Sanity: mocked writes never landed in the real jar.
    expect(document.cookie).toBe(before);
  });

  test('localStorage+cookie mode threads the configured domain into the identity mirror cookie', () => {
    const writes: string[] = [];
    const spy = vi.spyOn(document, 'cookie', 'set').mockImplementation((value: string) => {
      writes.push(value);
    });
    try {
      const backend = buildPropsBackend('localStorage+cookie', createMemoryBackend(), {
        cookieDomain: 'example.com',
      });
      backend.set('entry_mirror', { device_id: 'd', report_count: 9 });

      const cookieWrite = writes.find((w) => w.startsWith('entry_mirror='));
      expect(cookieWrite).toBeDefined();
      expect(cookieWrite).toContain('; domain=.example.com');
    } finally {
      spy.mockRestore();
      const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
      if (descriptor) {
        Object.defineProperty(document, 'cookie', descriptor);
      }
    }
    // localStorage still holds the full bulk blob.
    expect(localStorageBackend.parse('entry_mirror')).toEqual({ device_id: 'd', report_count: 9 });
  });

  test('no cookieDomain and no crossSubdomain ⇒ host-only cookie, no probe, no domain= attribute', () => {
    const before = document.cookie;
    const writes: string[] = [];
    const spy = vi.spyOn(document, 'cookie', 'set').mockImplementation((value: string) => {
      writes.push(value);
    });
    try {
      const backend = buildPropsBackend('cookie', createMemoryBackend());
      backend.set('entry_hostonly', { device_id: 'd' });

      expect(writes.at(-1)).not.toContain('domain=');
      expect(writes.some((w) => w.includes('domain_probe_'))).toBe(false);
    } finally {
      spy.mockRestore();
      const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
      if (descriptor) {
        Object.defineProperty(document, 'cookie', descriptor);
      }
    }
    expect(document.cookie).toBe(before);
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
