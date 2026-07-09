import { afterEach, describe, expect, test, vi } from 'vitest';
import { PersistenceStore } from './persistence-store';
import { createMemoryBackend, type StorageBackend, type StorageEntry } from './storage-backends';

// A backend that records every write, so debounce coalescing is observable.
function recordingBackend(): StorageBackend & { writes: StorageEntry[]; removes: string[] } {
  const inner = createMemoryBackend();
  const writes: StorageEntry[] = [];
  const removes: string[] = [];
  return {
    writes,
    removes,
    isSupported: () => true,
    get: (name) => inner.get(name),
    parse: (name) => inner.parse(name),
    set: (name, value) => {
      writes.push({ ...(value as StorageEntry) });
      return inner.set(name, value);
    },
    remove: (name) => {
      removes.push(name);
      inner.remove(name);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('register / register_once / unregister storage semantics', () => {
  test('register overwrites an existing key', () => {
    const store = new PersistenceStore({ backend: createMemoryBackend(), name: 's' });
    store.register({ device_id: 'first' });
    store.register({ device_id: 'second' });
    expect(store.getProperty('device_id')).toBe('second');
  });

  test('registerOnce keeps the first value', () => {
    const store = new PersistenceStore({ backend: createMemoryBackend(), name: 's' });
    store.registerOnce({ device_id: 'first' });
    store.registerOnce({ device_id: 'second' });
    expect(store.getProperty('device_id')).toBe('first');
  });

  test('registerOnce overwrites a key whose current value equals the supplied default', () => {
    const store = new PersistenceStore({ backend: createMemoryBackend(), name: 's' });
    store.register({ device_id: 'None' });
    store.registerOnce({ device_id: 'real' }, 'None');
    expect(store.getProperty('device_id')).toBe('real');
  });

  test('unregister removes a key', () => {
    const store = new PersistenceStore({ backend: createMemoryBackend(), name: 's' });
    store.register({ device_id: 'd' });
    store.unregister('device_id');
    expect(store.getProperty('device_id')).toBeUndefined();
  });

  test('register reports whether anything changed (no write when nothing changed)', () => {
    const store = new PersistenceStore({ backend: createMemoryBackend(), name: 's' });
    expect(store.register({ device_id: 'd' })).toBe(true);
    expect(store.register({ device_id: 'd' })).toBe(false);
  });
});

describe('object-valued super-props are detached on store (FIX E — no caller aliasing)', () => {
  test('mutating the caller object AFTER register does NOT mutate the stored value', () => {
    const store = new PersistenceStore({ backend: createMemoryBackend(), name: 's' });
    const profile = { plan: 'pro', flags: ['a'] };

    store.register({ profile });
    // The caller mutates its own object post-register.
    profile.plan = 'enterprise';
    profile.flags.push('b');

    // The stored (and thus emitted) value is unchanged — it was deep-copied on store.
    expect(store.getProperty('profile')).toEqual({ plan: 'pro', flags: ['a'] });
  });

  test('the snapshot returned by entries() is not the caller reference either', () => {
    const store = new PersistenceStore({ backend: createMemoryBackend(), name: 's' });
    const nested = { a: { b: 1 } };

    store.register({ nested });
    nested.a.b = 999;

    const stored = store.getProperty<{ a: { b: number } }>('nested');
    expect(stored?.a.b).toBe(1);
  });

  test('registerOnce also detaches object values from the caller', () => {
    const store = new PersistenceStore({ backend: createMemoryBackend(), name: 's' });
    const tags = { list: ['x'] };

    store.registerOnce({ tags });
    tags.list.push('y');

    expect(store.getProperty('tags')).toEqual({ list: ['x'] });
  });

  test('array-valued super-props are detached too', () => {
    const store = new PersistenceStore({ backend: createMemoryBackend(), name: 's' });
    const items = [{ id: 1 }];

    store.register({ items });
    items[0].id = 2;
    items.push({ id: 3 });

    expect(store.getProperty('items')).toEqual([{ id: 1 }]);
  });

  test('scalar super-props are stored by value unchanged (regression — no over-copying)', () => {
    const store = new PersistenceStore({ backend: createMemoryBackend(), name: 's' });
    store.register({ count: 5, name: 'kit', on: true });
    expect(store.getProperty('count')).toBe(5);
    expect(store.getProperty('name')).toBe('kit');
    expect(store.getProperty('on')).toBe(true);
  });

  test('a non-JSON value (Date) is deep-copied structurally, NOT flattened to a string (no fallback divergence)', () => {
    // The old JSON round-trip fallback would coerce a Date to a string; structuredClone (the
    // single copy path) preserves it as a Date, so the stored shape is environment-independent.
    const store = new PersistenceStore({ backend: createMemoryBackend(), name: 's' });
    const when = new Date('2024-01-02T03:04:05.000Z');

    store.register({ seenAt: { when } });

    const stored = store.getProperty<{ when: Date }>('seenAt');
    expect(stored?.when).toBeInstanceOf(Date);
    expect(stored?.when.getTime()).toBe(when.getTime());
    // Still detached — mutating the caller's Date does not reach the stored copy.
    when.setFullYear(1999);
    expect(store.getProperty<{ when: Date }>('seenAt')?.when.getFullYear()).toBe(2024);
  });
});

describe('load', () => {
  test('a fresh store hydrates its in-memory props from the backing entry', () => {
    const backend = createMemoryBackend();
    backend.set('s', { device_id: 'persisted' });
    const store = new PersistenceStore({ backend, name: 's' });
    expect(store.getProperty('device_id')).toBe('persisted');
  });
});

describe('save-debounce', () => {
  test('coalesces rapid writes into a single backend write', () => {
    vi.useFakeTimers();
    const backend = recordingBackend();
    const store = new PersistenceStore({ backend, name: 's', saveDebounceMs: 250 });

    store.register({ a: 1 });
    store.register({ b: 2 });
    store.register({ c: 3 });

    // Nothing written yet — all three coalesce into the pending window.
    expect(backend.writes).toHaveLength(0);

    vi.advanceTimersByTime(250);

    expect(backend.writes).toHaveLength(1);
    expect(backend.writes[0]).toEqual({ a: 1, b: 2, c: 3 });
  });

  test('writes synchronously when the debounce window is 0', () => {
    const backend = recordingBackend();
    const store = new PersistenceStore({ backend, name: 's', saveDebounceMs: 0 });

    store.register({ a: 1 });

    expect(backend.writes).toHaveLength(1);
  });
});

describe('unload flush', () => {
  test('flush forces a pending debounced write out immediately', () => {
    vi.useFakeTimers();
    const backend = recordingBackend();
    const store = new PersistenceStore({ backend, name: 's', saveDebounceMs: 250 });

    store.register({ a: 1 });
    expect(backend.writes).toHaveLength(0);

    store.flush();

    expect(backend.writes).toHaveLength(1);
    expect(backend.writes[0]).toEqual({ a: 1 });
  });

  test('a window unload event flushes pending writes', () => {
    vi.useFakeTimers();
    const backend = recordingBackend();
    const store = new PersistenceStore({ backend, name: 's', saveDebounceMs: 250 });

    store.register({ a: 1 });
    expect(backend.writes).toHaveLength(0);

    window.dispatchEvent(new Event('beforeunload'));

    expect(backend.writes).toHaveLength(1);
  });

  test('flush is a no-op when no write is pending (cannot resurrect a cleared entry)', () => {
    const backend = recordingBackend();
    const store = new PersistenceStore({ backend, name: 's', saveDebounceMs: 250 });

    store.clear();
    const writesAfterClear = backend.writes.length;
    store.flush();

    expect(backend.writes).toHaveLength(writesAfterClear);
  });
});
