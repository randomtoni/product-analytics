import { describe, expect, test } from 'vitest';
import { OfflineQueueStore, DEFAULT_MAX_PERSISTED_BATCHES } from './offline-queue';
import { createMemoryBackend, type StorageBackend } from './storage-backends';

const NAME = 'analytics_kit_queue_test';

function makeStore(
  overrides: Partial<{ allowed: boolean; maxBatches: number; backend: StorageBackend }> = {}
): { store: OfflineQueueStore<string>; backend: StorageBackend } {
  const backend = overrides.backend ?? createMemoryBackend();
  const store = new OfflineQueueStore<string>({
    backend,
    name: NAME,
    isPersistenceAllowed: () => overrides.allowed ?? true,
    maxBatches: overrides.maxBatches,
  });
  return { store, backend };
}

describe('OfflineQueueStore — persist / rehydrate round-trip', () => {
  test('persisted batches rehydrate in order on a fresh store against the same backend', () => {
    const backend = createMemoryBackend();
    const { store } = makeStore({ backend });

    store.persist([['a'], ['b', 'c']]);

    // A fresh store instance (a reload) reads the same backend.
    const { store: reloaded } = makeStore({ backend });
    expect(reloaded.rehydrate()).toEqual([['a'], ['b', 'c']]);
  });

  test('persists under an OBJECT envelope { batches: [...] }, not a bare array', () => {
    const backend = createMemoryBackend();
    const { store } = makeStore({ backend });

    store.persist([['a'], ['b']]);

    // The raw stored value is an object with a `batches` array — leaving room for a
    // version/metadata field and keeping the typed parse() path valid.
    const raw = JSON.parse(backend.get(NAME) as string) as Record<string, unknown>;
    expect(Array.isArray(raw)).toBe(false);
    expect(raw).toHaveProperty('batches');
    expect(raw.batches).toEqual([['a'], ['b']]);
  });

  test('the envelope is readable via the typed parse() path (parse(name)?.batches)', () => {
    const backend = createMemoryBackend();
    const { store } = makeStore({ backend });
    store.persist([['x']]);

    const entry = backend.parse(NAME);
    expect(entry?.batches).toEqual([['x']]);
  });
});

describe('OfflineQueueStore — prune on empty snapshot (delivered)', () => {
  test('persisting an empty snapshot clears the durable entry', () => {
    const backend = createMemoryBackend();
    const { store } = makeStore({ backend });
    store.persist([['a']]);
    expect(backend.get(NAME)).not.toBeNull();

    // A fully-flushed queue mirrors an empty snapshot → storage is cleared, not an
    // empty envelope left behind (the 2xx-prune AC in miniature).
    store.persist([]);
    expect(backend.get(NAME)).toBeNull();
  });
});

describe('OfflineQueueStore — size cap drops oldest', () => {
  test('past the cap, the OLDEST batches are dropped and the newest kept', () => {
    const backend = createMemoryBackend();
    const { store } = makeStore({ backend, maxBatches: 3 });

    store.persist([['1'], ['2'], ['3'], ['4'], ['5']]);

    // Oldest two dropped; the three most-recent survive, in order.
    const { store: reloaded } = makeStore({ backend, maxBatches: 3 });
    expect(reloaded.rehydrate()).toEqual([['3'], ['4'], ['5']]);
  });

  test('at exactly the cap nothing is dropped', () => {
    const backend = createMemoryBackend();
    const { store } = makeStore({ backend, maxBatches: 2 });
    store.persist([['1'], ['2']]);
    const { store: reloaded } = makeStore({ backend, maxBatches: 2 });
    expect(reloaded.rehydrate()).toEqual([['1'], ['2']]);
  });

  test('defaults to a bounded cap when none is supplied', () => {
    expect(DEFAULT_MAX_PERSISTED_BATCHES).toBeGreaterThan(0);
    const backend = createMemoryBackend();
    const { store } = makeStore({ backend });
    const many = Array.from({ length: DEFAULT_MAX_PERSISTED_BATCHES + 5 }, (_, i) => [String(i)]);
    store.persist(many);
    const { store: reloaded } = makeStore({ backend });
    expect(reloaded.rehydrate()).toHaveLength(DEFAULT_MAX_PERSISTED_BATCHES);
  });
});

describe('OfflineQueueStore — consent gating (opted-out persists nothing)', () => {
  test('a not-allowed store persists NOTHING and drops any existing durable queue', () => {
    const backend = createMemoryBackend();
    // First persist while allowed, then a not-allowed store must drop it.
    makeStore({ backend, allowed: true }).store.persist([['a']]);
    expect(backend.get(NAME)).not.toBeNull();

    const { store: denied } = makeStore({ backend, allowed: false });
    denied.persist([['b']]);
    expect(backend.get(NAME)).toBeNull();
  });

  test('a not-allowed store rehydrates NOTHING and drops the persisted queue', () => {
    const backend = createMemoryBackend();
    makeStore({ backend, allowed: true }).store.persist([['a']]);

    const { store: denied } = makeStore({ backend, allowed: false });
    expect(denied.rehydrate()).toEqual([]);
    expect(backend.get(NAME)).toBeNull();
  });
});

describe('OfflineQueueStore — rehydrate is a durable drain (read-then-clear)', () => {
  test('rehydrate clears the durable entry so a second rehydrate returns nothing', () => {
    const backend = createMemoryBackend();
    makeStore({ backend }).store.persist([['a']]);

    const { store } = makeStore({ backend });
    expect(store.rehydrate()).toEqual([['a']]);
    // Read-then-clear: the entry is gone — a persistently-failing batch cannot
    // rehydrate forever; the normal mirror re-persists only what stays undelivered.
    expect(backend.get(NAME)).toBeNull();
    expect(store.rehydrate()).toEqual([]);
  });
});

describe('OfflineQueueStore — corrupt / unexpected shape fails closed', () => {
  test('a non-array batches field yields no rehydrated batch (no throw)', () => {
    const backend = createMemoryBackend();
    backend.set(NAME, { batches: 'not-an-array' });
    const { store } = makeStore({ backend });
    expect(() => store.rehydrate()).not.toThrow();
    expect(store.rehydrate()).toEqual([]);
  });

  test('a missing batches field yields no rehydrated batch', () => {
    const backend = createMemoryBackend();
    backend.set(NAME, { something_else: 1 });
    const { store } = makeStore({ backend });
    expect(store.rehydrate()).toEqual([]);
  });

  test('malformed inner entries are filtered; well-formed batches survive', () => {
    const backend = createMemoryBackend();
    backend.set(NAME, { batches: [['ok'], 'bad', 42, ['also-ok']] });
    const { store } = makeStore({ backend });
    expect(store.rehydrate()).toEqual([['ok'], ['also-ok']]);
  });

  test('an absent entry rehydrates nothing', () => {
    const { store } = makeStore();
    expect(store.rehydrate()).toEqual([]);
  });
});

describe('OfflineQueueStore — drop', () => {
  test('drop removes the durable entry outright', () => {
    const backend = createMemoryBackend();
    const { store } = makeStore({ backend });
    store.persist([['a']]);
    store.drop();
    expect(backend.get(NAME)).toBeNull();
  });
});
