import { describe, expect, test } from 'vitest';
import {
  SessionIdManager,
  DEFAULT_SESSION_IDLE_TIMEOUT_MS,
  DEFAULT_SESSION_MAX_LENGTH_MS,
} from './session-id-manager';
import { PersistenceStore } from './persistence-store';
import { createMemoryBackend } from './storage-backends';
import { SESSION_ID_KEY } from './persistence-keys';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function freshStore(): PersistenceStore {
  return new PersistenceStore({ backend: createMemoryBackend(), name: 'session-test' });
}

// A deterministic id generator so minting is observable without parsing UUIDs.
function sequentialGenerator(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `session-${n}`;
  };
}

const T0 = 1_700_000_000_000; // an arbitrary fixed epoch-ms base

describe('session id assignment', () => {
  test('mints a UUIDv7 session id on the first call (real generator)', () => {
    const manager = new SessionIdManager({ store: freshStore() });

    expect(manager.checkAndGetSessionId(T0)).toMatch(UUID_V7);
  });

  test('returns the SAME id on subsequent calls within the idle window', () => {
    const manager = new SessionIdManager({ store: freshStore() });

    const first = manager.checkAndGetSessionId(T0);
    const second = manager.checkAndGetSessionId(T0 + 60_000);
    const third = manager.checkAndGetSessionId(T0 + 120_000);

    expect(second).toBe(first);
    expect(third).toBe(first);
  });
});

describe('idle expiry (default 30 min)', () => {
  test('a gap EXACTLY at the idle timeout does NOT expire (boundary is strict >)', () => {
    const manager = new SessionIdManager({
      store: freshStore(),
      sessionIdGenerator: sequentialGenerator(),
    });

    const first = manager.checkAndGetSessionId(T0);
    const atBoundary = manager.checkAndGetSessionId(T0 + DEFAULT_SESSION_IDLE_TIMEOUT_MS);

    expect(atBoundary).toBe(first);
  });

  test('a gap JUST past the idle timeout mints a new id', () => {
    const manager = new SessionIdManager({
      store: freshStore(),
      sessionIdGenerator: sequentialGenerator(),
    });

    const first = manager.checkAndGetSessionId(T0);
    const afterIdle = manager.checkAndGetSessionId(T0 + DEFAULT_SESSION_IDLE_TIMEOUT_MS + 1);

    expect(first).toBe('session-1');
    expect(afterIdle).toBe('session-2');
  });

  test('the idle clock advances from the EVENT timestamp — steady activity never idle-expires', () => {
    const manager = new SessionIdManager({
      store: freshStore(),
      sessionIdGenerator: sequentialGenerator(),
    });

    let last = manager.checkAndGetSessionId(T0);
    // 40 events, each 29 minutes apart (never idle for 30). 40*29min < 24h so
    // max-length never fires either — one session throughout.
    for (let i = 1; i <= 40; i++) {
      const id = manager.checkAndGetSessionId(T0 + i * 29 * 60 * 1000);
      expect(id).toBe(last);
      last = id;
    }
    expect(last).toBe('session-1');
  });
});

describe('max-length expiry (default 24 h)', () => {
  test('a session at EXACTLY max length does NOT expire (boundary is strict >)', () => {
    const manager = new SessionIdManager({
      store: freshStore(),
      sessionIdGenerator: sequentialGenerator(),
    });

    const first = manager.checkAndGetSessionId(T0);
    // Keep it active with sub-idle (20-min) steps so idle never fires, right up to
    // exactly the max length — isolating the max-length boundary from the idle one.
    let atMax = first;
    for (let t = T0 + 20 * 60 * 1000; t <= T0 + DEFAULT_SESSION_MAX_LENGTH_MS; t += 20 * 60 * 1000) {
      atMax = manager.checkAndGetSessionId(t);
    }
    atMax = manager.checkAndGetSessionId(T0 + DEFAULT_SESSION_MAX_LENGTH_MS);

    expect(atMax).toBe(first);
  });

  test('a session that stays active past 24 h mints a new id (max length, not idle)', () => {
    const manager = new SessionIdManager({
      store: freshStore(),
      sessionIdGenerator: sequentialGenerator(),
    });

    const first = manager.checkAndGetSessionId(T0);
    // Step every 20 minutes (never idle) across the 24h boundary.
    let last = first;
    for (let t = T0 + 20 * 60 * 1000; t <= T0 + DEFAULT_SESSION_MAX_LENGTH_MS; t += 20 * 60 * 1000) {
      last = manager.checkAndGetSessionId(t);
    }
    const pastMax = manager.checkAndGetSessionId(T0 + DEFAULT_SESSION_MAX_LENGTH_MS + 1);

    expect(first).toBe('session-1');
    // The session survived the whole active window (never idle)...
    expect(last).toBe('session-1');
    // ...then rotated only because it crossed max length.
    expect(pastMax).toBe('session-2');
  });
});

describe('config-overridable timeouts', () => {
  test('a custom idle timeout expires on its own schedule', () => {
    const manager = new SessionIdManager({
      store: freshStore(),
      idleTimeoutMs: 5_000,
      sessionIdGenerator: sequentialGenerator(),
    });

    const first = manager.checkAndGetSessionId(T0);
    const withinCustom = manager.checkAndGetSessionId(T0 + 4_000);
    const pastCustom = manager.checkAndGetSessionId(T0 + 4_000 + 5_001);

    expect(withinCustom).toBe(first);
    expect(pastCustom).not.toBe(first);
  });

  test('a custom max length expires on its own schedule', () => {
    const manager = new SessionIdManager({
      store: freshStore(),
      idleTimeoutMs: 60 * 60 * 1000, // wide idle so only max-length can trigger
      maxLengthMs: 10_000,
      sessionIdGenerator: sequentialGenerator(),
    });

    const first = manager.checkAndGetSessionId(T0);
    const pastCustomMax = manager.checkAndGetSessionId(T0 + 10_001);

    expect(first).toBe('session-1');
    expect(pastCustomMax).toBe('session-2');
  });
});

describe('resetSessionId (S9 entry point)', () => {
  test('clears the session so the next call mints a fresh id', () => {
    const manager = new SessionIdManager({
      store: freshStore(),
      sessionIdGenerator: sequentialGenerator(),
    });

    const first = manager.checkAndGetSessionId(T0);
    manager.resetSessionId();
    const afterReset = manager.checkAndGetSessionId(T0 + 1_000);

    expect(first).toBe('session-1');
    expect(afterReset).toBe('session-2');
  });

  test('reset removes the [WIRE] session tuple from the store', () => {
    const store = freshStore();
    const manager = new SessionIdManager({ store, sessionIdGenerator: sequentialGenerator() });

    manager.checkAndGetSessionId(T0);
    expect(store.getProperty(SESSION_ID_KEY)).toBeDefined();

    manager.resetSessionId();
    expect(store.getProperty(SESSION_ID_KEY)).toBeUndefined();
  });
});

describe('[WIRE] tuple normalization', () => {
  test('the persisted tuple is [lastActivity, id, start] and stays adapter-internal', () => {
    const store = freshStore();
    const manager = new SessionIdManager({ store, sessionIdGenerator: sequentialGenerator() });

    manager.checkAndGetSessionId(T0);

    const tuple = store.getProperty<[number, string, number]>(SESSION_ID_KEY);
    expect(tuple).toEqual([T0, 'session-1', T0]);
    // The neutral surface never sees the tuple shape — only the id string is returned.
    expect(SESSION_ID_KEY).not.toContain('$');
  });

  test('a corrupt / wrong-arity stored tuple is treated as no session (mints fresh)', () => {
    const store = freshStore();
    // Simulate a legacy / corrupt value under the key.
    store.register({ [SESSION_ID_KEY]: ['garbage'] as unknown });
    const manager = new SessionIdManager({ store, sessionIdGenerator: sequentialGenerator() });

    expect(manager.checkAndGetSessionId(T0)).toBe('session-1');
  });
});
