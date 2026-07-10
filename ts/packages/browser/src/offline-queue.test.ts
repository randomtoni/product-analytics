import { describe, expect, test } from 'vitest';
import { OfflineQueueStore, DEFAULT_MAX_PERSISTED_BATCHES } from './offline-queue';
import { createMemoryBackend, type EnumerableBackend, type StorageBackend } from './storage-backends';

// The shared base prefix all a project's per-tab keys start with. A tab's own key is
// `${PREFIX}${tabId}`; rehydrate/drop scan every key under PREFIX.
const PREFIX = 'analytics_kit_queue_test__';

type Enumerable = StorageBackend & EnumerableBackend;

function makeStore(
  overrides: Partial<{
    allowed: boolean;
    maxBatches: number;
    backend: Enumerable;
    tabId: string;
  }> = {}
): { store: OfflineQueueStore<string>; backend: Enumerable; name: string } {
  const backend = overrides.backend ?? createMemoryBackend();
  const name = `${PREFIX}${overrides.tabId ?? 'tab'}`;
  const store = new OfflineQueueStore<string>({
    backend,
    name,
    scanPrefix: PREFIX,
    isPersistenceAllowed: () => overrides.allowed ?? true,
    maxBatches: overrides.maxBatches,
  });
  return { store, backend, name };
}

describe('OfflineQueueStore — persist / rehydrate round-trip (single tab)', () => {
  test('persisted batches rehydrate in order on a fresh store against the same backend', () => {
    const backend = createMemoryBackend();
    const { store } = makeStore({ backend });

    store.persist([['a'], ['b', 'c']]);

    // A fresh store instance (a reload, same tab prefix) scans the same backend.
    const { store: reloaded } = makeStore({ backend });
    expect(reloaded.rehydrate()).toEqual([['a'], ['b', 'c']]);
  });

  test('persists under an OBJECT envelope { batches: [...] } at THIS tab\'s namespaced key', () => {
    const backend = createMemoryBackend();
    const { store, name } = makeStore({ backend });

    store.persist([['a'], ['b']]);

    // The raw stored value is an object with a `batches` array under the per-tab key —
    // leaving room for a version/metadata field and keeping the typed parse() path valid.
    const raw = JSON.parse(backend.get(name) as string) as Record<string, unknown>;
    expect(Array.isArray(raw)).toBe(false);
    expect(raw).toHaveProperty('batches');
    expect(raw.batches).toEqual([['a'], ['b']]);
  });

  test('the envelope is readable via the typed parse() path (parse(name)?.batches)', () => {
    const backend = createMemoryBackend();
    const { store, name } = makeStore({ backend });
    store.persist([['x']]);

    const entry = backend.parse(name);
    expect(entry?.batches).toEqual([['x']]);
  });
});

describe('OfflineQueueStore — multi-tab: an empty snapshot never clobbers a sibling tab', () => {
  test("tab B's persist([]) leaves tab A's namespaced key UNTOUCHED (the clobber is gone)", () => {
    const backend = createMemoryBackend();

    // Tab A persists undelivered batches under ITS namespaced key.
    const { store: tabA, name: nameA } = makeStore({ backend, tabId: 'A' });
    tabA.persist([['a1'], ['a2']]);
    expect(backend.get(nameA)).not.toBeNull();

    // Tab B constructs with an EMPTY retry queue and persists the empty snapshot. Under the
    // OLD shared-key design this removed the ONE shared key and DELETED tab A's batches.
    const { store: tabB, name: nameB } = makeStore({ backend, tabId: 'B' });
    tabB.persist([]);

    // Tab A's key — and its batches — survive; tab B only cleared its OWN (never-written) key.
    expect(backend.get(nameA)).not.toBeNull();
    const envelope = JSON.parse(backend.get(nameA) as string) as { batches: string[][] };
    expect(envelope.batches).toEqual([['a1'], ['a2']]);
    expect(backend.get(nameB)).toBeNull();
  });

  test("tab B's drop() (opt-out) DOES reap tab A's key — a denial clears every tab", () => {
    const backend = createMemoryBackend();
    const { store: tabA, name: nameA } = makeStore({ backend, tabId: 'A' });
    tabA.persist([['a1']]);

    // A consent denial routes through drop(), which must clear the whole cross-tab queue so
    // nothing rehydrates after the opt-out — not just the denying tab's own key.
    const { store: tabB } = makeStore({ backend, tabId: 'B' });
    tabB.drop();

    expect(backend.get(nameA)).toBeNull();
  });
});

describe('OfflineQueueStore — rehydrate unions ALL tabs then clears every scanned key', () => {
  test('a reload receives the UNION of every tab\'s batches, and all namespaced keys are cleared', () => {
    const backend = createMemoryBackend();

    // Two tabs each mirror undelivered batches under their own key.
    makeStore({ backend, tabId: 'A' }).store.persist([['a1'], ['a2']]);
    makeStore({ backend, tabId: 'B' }).store.persist([['b1']]);
    expect(backend.listKeysByPrefix(PREFIX)).toHaveLength(2);

    // A reload (a fresh tab C) rehydrates: it scans BOTH keys and unions their batches.
    const { store: tabC } = makeStore({ backend, tabId: 'C' });
    const rehydrated = tabC.rehydrate();
    expect(rehydrated).toEqual([['a1'], ['a2'], ['b1']]);

    // Read-then-clear across all tabs: every scanned key is removed (ownership taken into
    // this tab's in-memory retry queue + orphans from closed tabs reaped).
    expect(backend.listKeysByPrefix(PREFIX)).toEqual([]);
    // A second rehydrate finds nothing.
    expect(tabC.rehydrate()).toEqual([]);
  });

  test('rehydrate reaps an ORPHAN key left by a crashed/closed tab that never reloaded', () => {
    const backend = createMemoryBackend();
    // Simulate a crashed tab: its namespaced key persists with undelivered batches.
    backend.set(`${PREFIX}crashed`, { batches: [['orphan']] });

    const { store } = makeStore({ backend, tabId: 'live' });
    expect(store.rehydrate()).toEqual([['orphan']]);
    // The orphan key is gone — taken into this tab, not left to accumulate forever.
    expect(backend.listKeysByPrefix(PREFIX)).toEqual([]);
  });
});

describe('OfflineQueueStore — prune on empty snapshot (delivered)', () => {
  test("persisting an empty snapshot clears THIS tab's durable entry", () => {
    const backend = createMemoryBackend();
    const { store, name } = makeStore({ backend });
    store.persist([['a']]);
    expect(backend.get(name)).not.toBeNull();

    // A fully-flushed queue mirrors an empty snapshot → this tab's key is cleared, not an
    // empty envelope left behind (the 2xx-prune AC in miniature).
    store.persist([]);
    expect(backend.get(name)).toBeNull();
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

  test('the UNION across tabs is capped after merge (oldest dropped past the cap)', () => {
    const backend = createMemoryBackend();
    // Two tabs each persist 2 batches; the union of 4 exceeds a cap of 3.
    makeStore({ backend, tabId: 'A', maxBatches: 3 }).store.persist([['a1'], ['a2']]);
    makeStore({ backend, tabId: 'B', maxBatches: 3 }).store.persist([['b1'], ['b2']]);

    const { store: reloaded } = makeStore({ backend, tabId: 'C', maxBatches: 3 });
    // Union in scan order is [a1,a2,b1,b2]; capped to the last 3.
    expect(reloaded.rehydrate()).toEqual([['a2'], ['b1'], ['b2']]);
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
  test('a not-allowed store persists NOTHING and drops every existing durable queue', () => {
    const backend = createMemoryBackend();
    // First persist while allowed (from another tab), then a not-allowed store must drop it.
    makeStore({ backend, tabId: 'A', allowed: true }).store.persist([['a']]);
    expect(backend.listKeysByPrefix(PREFIX)).toHaveLength(1);

    const { store: denied } = makeStore({ backend, tabId: 'B', allowed: false });
    denied.persist([['b']]);
    // The denial drops the whole cross-tab queue and persists nothing new.
    expect(backend.listKeysByPrefix(PREFIX)).toEqual([]);
  });

  test('a not-allowed store rehydrates NOTHING and drops every persisted queue', () => {
    const backend = createMemoryBackend();
    makeStore({ backend, tabId: 'A', allowed: true }).store.persist([['a']]);

    const { store: denied } = makeStore({ backend, tabId: 'B', allowed: false });
    expect(denied.rehydrate()).toEqual([]);
    expect(backend.listKeysByPrefix(PREFIX)).toEqual([]);
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
    expect(backend.listKeysByPrefix(PREFIX)).toEqual([]);
    expect(store.rehydrate()).toEqual([]);
  });
});

describe('OfflineQueueStore — corrupt / unexpected shape fails closed', () => {
  test('a non-array batches field yields no rehydrated batch (no throw)', () => {
    const backend = createMemoryBackend();
    backend.set(`${PREFIX}tab`, { batches: 'not-an-array' });
    const { store } = makeStore({ backend });
    expect(() => store.rehydrate()).not.toThrow();
    backend.set(`${PREFIX}tab`, { batches: 'not-an-array' });
    expect(store.rehydrate()).toEqual([]);
  });

  test('a missing batches field yields no rehydrated batch', () => {
    const backend = createMemoryBackend();
    backend.set(`${PREFIX}tab`, { something_else: 1 });
    const { store } = makeStore({ backend });
    expect(store.rehydrate()).toEqual([]);
  });

  test('malformed inner entries are filtered; well-formed batches survive', () => {
    const backend = createMemoryBackend();
    backend.set(`${PREFIX}tab`, { batches: [['ok'], 'bad', 42, ['also-ok']] });
    const { store } = makeStore({ backend });
    expect(store.rehydrate()).toEqual([['ok'], ['also-ok']]);
  });

  test('an absent entry rehydrates nothing', () => {
    const { store } = makeStore();
    expect(store.rehydrate()).toEqual([]);
  });
});

describe('OfflineQueueStore — drop', () => {
  test("drop removes THIS tab's durable entry outright", () => {
    const backend = createMemoryBackend();
    const { store, name } = makeStore({ backend });
    store.persist([['a']]);
    store.drop();
    expect(backend.get(name)).toBeNull();
  });
});
