import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  AnalyticsAdapter,
  AnalyticsConfig,
  NeutralEvent,
  NeutralFetchOptions,
} from 'analytics-kit';
import { BrowserAdapter, type BrowserAdapterOptions } from './browser-adapter';
import {
  ANONYMOUS_DISTINCT_ID_KEY,
  DEVICE_ID_KEY,
  DISTINCT_ID_KEY,
  IDENTITY_STATE_KEY,
  MERGE_EVENT,
  SET_TRAITS_KEY,
  SET_TRAITS_ONCE_KEY,
  storeName,
} from './persistence-keys';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function makeEvent(overrides: Partial<NeutralEvent> = {}): NeutralEvent {
  return {
    event: 'x',
    distinctId: 'anonymous',
    dedupeId: 'dedupe-1',
    timestamp: new Date(),
    ...overrides,
  };
}

let keySeq = 0;
function freshKey(): string {
  keySeq += 1;
  return `test-${keySeq}-${Math.random().toString(36).slice(2)}`;
}

afterEach(() => {
  vi.useRealTimers();
});

test('satisfies the shipped AnalyticsAdapter SPI (structural conformance)', () => {
  const adapter: AnalyticsAdapter = new BrowserAdapter({ key: freshKey() });
  expect(adapter).toBeInstanceOf(BrowserAdapter);
});

test('capture runs without throwing and returns void', () => {
  const adapter = new BrowserAdapter({ key: freshKey() });
  expect(adapter.capture(makeEvent())).toBeUndefined();
});

test('the capture pipeline stamps a UUIDv7 sessionId with no super-props registered — S8 hook now stamping', () => {
  const adapter = new BrowserAdapter({ key: freshKey() });
  const event = makeEvent();

  const result = adapter.runCapturePipeline(event);

  expect(result.sessionId).toMatch(UUID_V7);
  // No consumer super-props registered ⇒ properties bag is unchanged (identity keys
  // in the store are reserved and never merged in).
  expect(result.properties).toBeUndefined();
});

test('the capture pipeline stamps a fresh sessionId even when the event carried one — the adapter is authoritative', () => {
  const adapter = new BrowserAdapter({ key: freshKey() });
  adapter.register({ plan: 'pro' });
  const event = makeEvent({ sessionId: 'stale-caller-value', properties: { a: 1 } });

  const result = adapter.runCapturePipeline(event);

  // The adapter owns the session id; a value the caller happened to set is overwritten.
  expect(result.sessionId).toMatch(UUID_V7);
  expect(result.sessionId).not.toBe('stale-caller-value');
  expect(result.properties).toEqual({ plan: 'pro', a: 1 });
});

test('a fresh store reads back nothing for a never-written key', () => {
  const adapter: AnalyticsAdapter = new BrowserAdapter({ key: freshKey() });
  // Identity bootstrap now seeds distinct_id / device_id / identity_state at
  // construction, so this probes a key nothing has written.
  expect(adapter.getPersistedProperty('never_written')).toBeUndefined();
});

test('exposes a neutral, non-vendor library id and version', () => {
  const adapter = new BrowserAdapter({ key: freshKey() });
  expect(adapter.getLibraryId()).toBe('analytics-kit-browser');
  expect(adapter.getLibraryVersion()).toBe('0.0.0');
  expect(adapter.getCustomUserAgent()).toBeUndefined();
});

test('flush and shutdown resolve (no transport resource held yet — E5)', async () => {
  const adapter = new BrowserAdapter({ key: freshKey() });
  await expect(adapter.flush()).resolves.toBeUndefined();
  await expect(adapter.shutdown()).resolves.toBeUndefined();
});

test('backs the SPI: setPersistedProperty then getPersistedProperty round-trips (default mode)', () => {
  const adapter = new BrowserAdapter({ key: freshKey() });

  adapter.setPersistedProperty('distinct_id', 'user-1');

  expect(adapter.getPersistedProperty('distinct_id')).toBe('user-1');
});

test('setPersistedProperty(key, null) removes the value', () => {
  const adapter = new BrowserAdapter({ key: freshKey() });
  adapter.setPersistedProperty('distinct_id', 'user-1');

  adapter.setPersistedProperty('distinct_id', null);

  expect(adapter.getPersistedProperty('distinct_id')).toBeUndefined();
});

describe.each(['cookie', 'localStorage+cookie', 'memory'] as const)(
  'persistence mode %s',
  (persistence) => {
    test('round-trips a value within the same store instance', () => {
      const adapter = new BrowserAdapter({ key: freshKey(), persistence });

      adapter.setPersistedProperty('device_id', 'dev-9');

      expect(adapter.getPersistedProperty('device_id')).toBe('dev-9');
    });
  }
);

test('durable modes survive a reload (a fresh store instance re-reads the value)', () => {
  for (const persistence of ['cookie', 'localStorage+cookie'] as const) {
    const key = freshKey();
    // Persistence is gated on consent (S3): grant durably first, then the writing
    // adapter reads 'granted' at construction and builds the durable store.
    new BrowserAdapter({ key, persistence }).setConsentState('granted');
    const writer = new BrowserAdapter({ key, persistence });
    writer.setPersistedProperty('device_id', 'dev-durable');
    // A real reload fires the unload flush first, landing the debounced write.
    window.dispatchEvent(new Event('beforeunload'));

    const reloaded = new BrowserAdapter({ key, persistence });

    expect(reloaded.getPersistedProperty('device_id')).toBe('dev-durable');
  }
});

test('memory mode persists nothing across a fresh store instance', () => {
  const key = freshKey();
  // A non-identity key: identity keys are re-minted at construction, so probe one
  // nothing re-seeds to prove the memory backing is truly ephemeral across reload.
  new BrowserAdapter({ key, persistence: 'memory' }).setPersistedProperty('custom_prop', 'vanishes');
  window.dispatchEvent(new Event('beforeunload'));

  const reloaded = new BrowserAdapter({ key, persistence: 'memory' });

  expect(reloaded.getPersistedProperty('custom_prop')).toBeUndefined();
});

test('a fresh adapter defaults to pending, and the consent SPI pair round-trips', () => {
  const adapter = new BrowserAdapter({ key: freshKey() });

  expect(adapter.getConsentState()).toBe('pending');

  adapter.setConsentState('granted');
  expect(adapter.getConsentState()).toBe('granted');
});

test('the consent decision survives a reload — set denied, reconstruct, read denied (zero cookies)', () => {
  const key = freshKey();
  new BrowserAdapter({ key }).setConsentState('denied');

  const reloaded = new BrowserAdapter({ key });

  expect(reloaded.getConsentState()).toBe('denied');
  expect(document.cookie).not.toContain(key);
});

test('a pending (default/unasked) adapter writes zero cookies even when a property is set', () => {
  const key = freshKey();
  const adapter = new BrowserAdapter({ key, persistence: 'localStorage+cookie' });
  expect(adapter.getConsentState()).toBe('pending');

  adapter.setPersistedProperty('device_id', 'dev-1');
  window.dispatchEvent(new Event('beforeunload'));

  expect(document.cookie).not.toContain(key);
});

test('a denied adapter writes zero cookies exactly like pending', () => {
  const key = freshKey();
  new BrowserAdapter({ key, persistence: 'localStorage+cookie' }).setConsentState('denied');
  const adapter = new BrowserAdapter({ key, persistence: 'localStorage+cookie' });

  adapter.setPersistedProperty('device_id', 'dev-1');
  window.dispatchEvent(new Event('beforeunload'));

  expect(document.cookie).not.toContain(key);
});

test('only a granted adapter permits cookie writes', () => {
  const key = freshKey();
  new BrowserAdapter({ key, persistence: 'localStorage+cookie' }).setConsentState('granted');
  const adapter = new BrowserAdapter({ key, persistence: 'localStorage+cookie' });

  adapter.setPersistedProperty('device_id', 'dev-1');
  window.dispatchEvent(new Event('beforeunload'));

  expect(document.cookie).toContain(key);
});

test('a platform DNT signal resolves getConsentState() to denied — no DNT concept on the seam', () => {
  const adapter = new BrowserAdapter({ key: freshKey() });
  adapter.setConsentState('granted');
  expect(adapter.getConsentState()).toBe('granted');

  Object.defineProperty(window.navigator, 'doNotTrack', { value: '1', configurable: true });
  try {
    expect(adapter.getConsentState()).toBe('denied');
  } finally {
    Object.defineProperty(window.navigator, 'doNotTrack', { value: undefined, configurable: true });
  }
});

test('a DNT signal at construction gates the property store to memory — zero cookies', () => {
  const key = freshKey();
  new BrowserAdapter({ key, persistence: 'localStorage+cookie' }).setConsentState('granted');

  Object.defineProperty(window.navigator, 'doNotTrack', { value: '1', configurable: true });
  try {
    const adapter = new BrowserAdapter({ key, persistence: 'localStorage+cookie' });
    adapter.setPersistedProperty('device_id', 'dev-1');
    window.dispatchEvent(new Event('beforeunload'));

    expect(document.cookie).not.toContain(key);
  } finally {
    Object.defineProperty(window.navigator, 'doNotTrack', { value: undefined, configurable: true });
  }
});

test('getDistinctId returns a minted UUIDv7 anonymous distinct id at first load', () => {
  const adapter = new BrowserAdapter({ key: freshKey() });

  expect(adapter.getDistinctId()).toMatch(UUID_V7);
});

test('the anonymous distinct id survives a reload (a fresh adapter re-reads the same id)', () => {
  const key = freshKey();
  // Persistence is consent-gated: grant durably, then the writer mints into the
  // durable store, and the unload flush lands the debounced write.
  new BrowserAdapter({ key }).setConsentState('granted');
  const writer = new BrowserAdapter({ key, persistence: 'localStorage+cookie' });
  const mintedId = writer.getDistinctId();
  window.dispatchEvent(new Event('beforeunload'));

  const reloaded = new BrowserAdapter({ key, persistence: 'localStorage+cookie' });

  expect(reloaded.getDistinctId()).toBe(mintedId);
});

test('the device id is persisted under a SEPARATE key from the distinct id', () => {
  const adapter = new BrowserAdapter({ key: freshKey() });

  const distinctId = adapter.getDistinctId();
  const deviceId = adapter.getPersistedProperty<string>(DEVICE_ID_KEY);
  const storedDistinctId = adapter.getPersistedProperty<string>(DISTINCT_ID_KEY);

  expect(deviceId).toMatch(UUID_V7);
  expect(storedDistinctId).toBe(distinctId);
  expect(deviceId).not.toBe(distinctId);
});

test('identity state is persisted as an explicit neutral anonymous value — no $-key, no id-equality trick', () => {
  const adapter = new BrowserAdapter({ key: freshKey() });

  expect(adapter.getPersistedProperty(IDENTITY_STATE_KEY)).toBe('anonymous');
  expect(IDENTITY_STATE_KEY).not.toContain('$');
  // The neutral surface never exposes an identity-state getter this epic.
  expect('getIdentityState' in adapter).toBe(false);
});

test('the device-id generator is injectable — swaps the device-id scheme only', () => {
  const adapter = new BrowserAdapter({
    key: freshKey(),
    deviceIdGenerator: () => 'injected-device-scheme',
  });

  expect(adapter.getPersistedProperty(DEVICE_ID_KEY)).toBe('injected-device-scheme');
  // The distinct id is untouched by the device-id scheme swap.
  expect(adapter.getDistinctId()).toMatch(UUID_V7);
});

describe('super-property registration (S7)', () => {
  test('register persists a super-prop and merges it into a subsequently captured event — trusted, no re-gate', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });

    adapter.register({ plan: 'pro' });

    // Persisted (S2 storage).
    expect(adapter.getPersistedProperty('plan')).toBe('pro');
    // Merged downstream into the event property bag.
    const result = adapter.runCapturePipeline(makeEvent({ properties: { a: 1 } }));
    expect(result.properties).toEqual({ plan: 'pro', a: 1 });
  });

  test('register overwrites an existing super-prop', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });

    adapter.register({ plan: 'free' });
    adapter.register({ plan: 'pro' });

    expect(adapter.getPersistedProperty('plan')).toBe('pro');
  });

  test('register(props, { once: true }) keeps the first value (first-touch-immutable)', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });

    adapter.register({ plan: 'free' }, { once: true });
    adapter.register({ plan: 'pro' }, { once: true });

    expect(adapter.getPersistedProperty('plan')).toBe('free');
  });

  test('unregister removes a super-prop — it no longer persists or merges', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });
    adapter.register({ plan: 'pro' });

    adapter.unregister('plan');

    expect(adapter.getPersistedProperty('plan')).toBeUndefined();
    const result = adapter.runCapturePipeline(makeEvent());
    expect(result.properties).toBeUndefined();
  });

  test('a per-call event property WINS over a registered super-prop of the same key (super-props are defaults)', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });
    adapter.register({ plan: 'free' });

    const result = adapter.runCapturePipeline(makeEvent({ properties: { plan: 'pro' } }));

    expect(result.properties).toEqual({ plan: 'pro' });
  });

  test('identity / library-computed keys are NEVER merged into events — the reserved-key exemption holds', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });
    // The adapter has already seeded distinct_id / device_id / identity_state into the
    // same store at construction; register a consumer super-prop alongside them.
    adapter.register({ plan: 'pro' });

    const result = adapter.runCapturePipeline(makeEvent());

    // Only the consumer super-prop rides on the event — the reserved identity keys do not.
    expect(result.properties).toEqual({ plan: 'pro' });
    expect(result.properties).not.toHaveProperty(DISTINCT_ID_KEY);
    expect(result.properties).not.toHaveProperty(DEVICE_ID_KEY);
    expect(result.properties).not.toHaveProperty(IDENTITY_STATE_KEY);
  });

  test('multiple registered super-props all merge into the event', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });

    adapter.register({ plan: 'pro' });
    adapter.register({ theme: 'dark' }, { once: true });

    const result = adapter.runCapturePipeline(makeEvent({ properties: { a: 1 } }));

    expect(result.properties).toEqual({ plan: 'pro', theme: 'dark', a: 1 });
  });
});

describe('cross-subdomain cookie domain (S4)', () => {
  // Capture every raw `document.cookie` write so a domain= attribute can be
  // asserted even when jsdom would reject a cross-origin domain (jsdom only
  // accepts a domain= matching the localhost origin).
  function withCookieWriteSpy(run: (writes: string[]) => void): void {
    const writes: string[] = [];
    const spy = vi.spyOn(document, 'cookie', 'set').mockImplementation((value: string) => {
      writes.push(value);
    });
    try {
      run(writes);
    } finally {
      spy.mockRestore();
      const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
      if (descriptor) {
        Object.defineProperty(document, 'cookie', descriptor);
      }
    }
  }

  test('with cookieDomain set + granted, the identity cookie is written at that domain', () => {
    const key = freshKey();
    // Grant consent durably first (S3 gate) — only then does the cookie path run.
    new BrowserAdapter({ key, persistence: 'localStorage+cookie' }).setConsentState('granted');

    withCookieWriteSpy((writes) => {
      const adapter = new BrowserAdapter({
        key,
        persistence: 'localStorage+cookie',
        cookieDomain: 'example.com',
      });
      adapter.setPersistedProperty('device_id', 'dev-1');
      window.dispatchEvent(new Event('beforeunload'));

      const identityCookieWrite = writes.find((w) => w.startsWith(storeName(key)));
      expect(identityCookieWrite).toBeDefined();
      expect(identityCookieWrite).toContain('; domain=.example.com');
    });
  });

  test('cross-subdomain journey with a host-matching cookieDomain keeps ONE distinct id', () => {
    // jsdom accepts domain=.localhost (matches the origin), so the cookie truly
    // round-trips — a second adapter (a different subdomain, same domain scope)
    // reads back the identity the first minted. cookie mode so the id lives in
    // the domain-scoped cookie, not localStorage.
    const key = freshKey();
    new BrowserAdapter({ key, persistence: 'cookie' }).setConsentState('granted');

    const first = new BrowserAdapter({
      key,
      persistence: 'cookie',
      cookieDomain: 'localhost',
    });
    const mintedId = first.getDistinctId();
    window.dispatchEvent(new Event('beforeunload'));

    const secondSubdomain = new BrowserAdapter({
      key,
      persistence: 'cookie',
      cookieDomain: 'localhost',
    });

    expect(secondSubdomain.getDistinctId()).toBe(mintedId);
  });

  test('with cookieDomain set, the public-suffix probe does NOT run (config authoritative)', () => {
    const key = freshKey();
    new BrowserAdapter({ key, persistence: 'localStorage+cookie' }).setConsentState('granted');

    withCookieWriteSpy((writes) => {
      new BrowserAdapter({
        key,
        persistence: 'localStorage+cookie',
        cookieDomain: 'example.com',
        crossSubdomainCookie: true,
      });

      // No throwaway probe cookie was written — the config domain short-circuits it.
      expect(writes.some((w) => w.includes('domain_probe_'))).toBe(false);
    });
  });

  test('opted-out (denied): the probe writes ZERO throwaway cookies (gated by the consent-first read)', () => {
    const key = freshKey();
    new BrowserAdapter({ key, persistence: 'localStorage+cookie' }).setConsentState('denied');

    withCookieWriteSpy((writes) => {
      new BrowserAdapter({
        key,
        persistence: 'localStorage+cookie',
        crossSubdomainCookie: true,
      });

      // effectiveMode collapsed to memory ⇒ buildPropsBackend never resolved a
      // domain ⇒ the probe never ran ⇒ zero throwaway cookies.
      expect(writes.some((w) => w.includes('domain_probe_'))).toBe(false);
      expect(writes).toHaveLength(0);
    });
  });

  test('pending (default/unasked): the probe writes ZERO throwaway cookies', () => {
    const key = freshKey();

    withCookieWriteSpy((writes) => {
      const adapter = new BrowserAdapter({
        key,
        persistence: 'localStorage+cookie',
        crossSubdomainCookie: true,
      });
      expect(adapter.getConsentState()).toBe('pending');

      expect(writes.some((w) => w.includes('domain_probe_'))).toBe(false);
      expect(writes).toHaveLength(0);
    });
  });

  test('granted + crossSubdomain requested + no cookieDomain: the probe path runs (may write a probe), then is gone', () => {
    // Under jsdom the origin is localhost, so the probe short-circuits to empty and
    // no probe cookie is stored — but the point of this test is the granted path is
    // the ONLY place the probe is even reached. Contrast with the denied/pending
    // tests above where zero cookies are written at all.
    const key = freshKey();
    new BrowserAdapter({ key, persistence: 'localStorage+cookie' }).setConsentState('granted');

    expect(() => {
      new BrowserAdapter({
        key,
        persistence: 'localStorage+cookie',
        crossSubdomainCookie: true,
      });
    }).not.toThrow();
  });
});

describe('session id stamping (S8)', () => {
  const IDLE_MS = 30 * 60 * 1000;
  const MAX_MS = 24 * 60 * 60 * 1000;

  test('stamps a UUIDv7 sessionId on the event via the pipeline', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });

    const result = adapter.runCapturePipeline(makeEvent());

    expect(result.sessionId).toMatch(UUID_V7);
  });

  test('the same session id is stamped across events within the idle window', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });
    const base = new Date('2026-07-08T00:00:00.000Z').getTime();

    const first = adapter.runCapturePipeline(makeEvent({ timestamp: new Date(base) }));
    const second = adapter.runCapturePipeline(
      makeEvent({ timestamp: new Date(base + 10 * 60 * 1000) })
    );

    expect(second.sessionId).toBe(first.sessionId);
  });

  test('idle expiry (default 30 min, event-timestamp driven) stamps a NEW id', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });
    const base = new Date('2026-07-08T00:00:00.000Z').getTime();

    const first = adapter.runCapturePipeline(makeEvent({ timestamp: new Date(base) }));
    const afterIdle = adapter.runCapturePipeline(
      makeEvent({ timestamp: new Date(base + IDLE_MS + 1) })
    );

    expect(afterIdle.sessionId).toMatch(UUID_V7);
    expect(afterIdle.sessionId).not.toBe(first.sessionId);
  });

  test('max-length expiry (default 24 h) stamps a NEW id even under steady activity', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });
    const base = new Date('2026-07-08T00:00:00.000Z').getTime();

    const first = adapter.runCapturePipeline(makeEvent({ timestamp: new Date(base) }));
    // Keep it active every 20 min so idle never triggers, up past 24h.
    let last = first;
    for (let t = base + 20 * 60 * 1000; t <= base + MAX_MS; t += 20 * 60 * 1000) {
      last = adapter.runCapturePipeline(makeEvent({ timestamp: new Date(t) }));
    }
    expect(last.sessionId).toBe(first.sessionId);

    const pastMax = adapter.runCapturePipeline(makeEvent({ timestamp: new Date(base + MAX_MS + 1) }));
    expect(pastMax.sessionId).not.toBe(first.sessionId);
  });

  test('config-overridable via BrowserAdapterOptions — a custom idle timeout is honored', () => {
    const adapter = new BrowserAdapter({ key: freshKey(), sessionIdleTimeoutMs: 5_000 });
    const base = new Date('2026-07-08T00:00:00.000Z').getTime();

    const first = adapter.runCapturePipeline(makeEvent({ timestamp: new Date(base) }));
    const withinCustom = adapter.runCapturePipeline(makeEvent({ timestamp: new Date(base + 4_000) }));
    const pastCustom = adapter.runCapturePipeline(
      makeEvent({ timestamp: new Date(base + 4_000 + 5_001) })
    );

    expect(withinCustom.sessionId).toBe(first.sessionId);
    expect(pastCustom.sessionId).not.toBe(first.sessionId);
  });

  test('a session id is minted even in persistence: memory mode', () => {
    const adapter = new BrowserAdapter({ key: freshKey(), persistence: 'memory' });

    const result = adapter.runCapturePipeline(makeEvent());

    expect(result.sessionId).toMatch(UUID_V7);
  });

  test('an event without a timestamp falls back to now (fake timers) — still stamps', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-08T12:00:00.000Z'));
    const adapter = new BrowserAdapter({ key: freshKey() });

    const result = adapter.runCapturePipeline(makeEvent({ timestamp: undefined }));

    expect(result.sessionId).toMatch(UUID_V7);
  });

  test('the [WIRE] session tuple is normalized inside the adapter — never on the event, no $-key', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });

    const result = adapter.runCapturePipeline(makeEvent());

    // The event carries only the neutral string id, never the [lastActivity,id,start] tuple.
    expect(typeof result.sessionId).toBe('string');
    // No reserved / library-computed key (including the session tuple key) leaks into props.
    expect(result.properties ?? {}).not.toHaveProperty('session_id');
    for (const key of Object.keys(result.properties ?? {})) {
      expect(key).not.toContain('$');
    }
  });
});

describe('identify — client-side anon→identified merge (S6)', () => {
  test('a NEW id while anonymous performs the merge and transitions state to identified', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });
    const anonId = adapter.getDistinctId();
    const capture = vi.spyOn(adapter, 'capture');

    adapter.identify('user-1');

    // The distinct id is swapped to the identified id (cache + persisted in lockstep).
    expect(adapter.getDistinctId()).toBe('user-1');
    expect(adapter.getPersistedProperty(DISTINCT_ID_KEY)).toBe('user-1');
    // State flipped anonymous → identified (persisted).
    expect(adapter.getPersistedProperty(IDENTITY_STATE_KEY)).toBe('identified');
    // A merge event was emitted carrying the new distinct id.
    expect(capture).toHaveBeenCalledTimes(1);
    const merge = capture.mock.calls[0][0];
    expect(merge.event).toBe(MERGE_EVENT);
    expect(merge.distinctId).toBe('user-1');
    // The id genuinely changed from the anonymous one.
    expect(anonId).not.toBe('user-1');
  });

  test('the merge carries the RETAINED prior anonymous id as an adapter-internal [WIRE] payload', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });
    const anonId = adapter.getDistinctId();
    const capture = vi.spyOn(adapter, 'capture');

    adapter.identify('user-1');

    const merge = capture.mock.calls[0][0];
    // The prior anon id rides the merge event as the de-branded link property.
    expect(merge.properties?.[ANONYMOUS_DISTINCT_ID_KEY]).toBe(anonId);
    // And it is RETAINED in persistence (not just swapped) so a later in-flight call
    // keeps the merge linkage.
    expect(adapter.getPersistedProperty(ANONYMOUS_DISTINCT_ID_KEY)).toBe(anonId);
  });

  test('no `$`-prefixed name appears on the merge event or its properties (neutral-surface hygiene)', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });
    const capture = vi.spyOn(adapter, 'capture');

    adapter.identify('user-1', { plan: 'pro' }, { signup_date: '2026-07-08' });

    const merge = capture.mock.calls[0][0];
    expect(merge.event).not.toContain('$');
    for (const key of Object.keys(merge.properties ?? {})) {
      expect(key).not.toContain('$');
    }
    // Nested trait-bag keys are de-branded too.
    for (const bag of [SET_TRAITS_KEY, SET_TRAITS_ONCE_KEY]) {
      for (const key of Object.keys((merge.properties?.[bag] as object) ?? {})) {
        expect(key).not.toContain('$');
      }
    }
  });

  test('the SAME id updates traits only — no re-merge, no state churn, prior anon id untouched', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });
    adapter.identify('user-1');
    const retainedAnon = adapter.getPersistedProperty(ANONYMOUS_DISTINCT_ID_KEY);
    const capture = vi.spyOn(adapter, 'capture');

    adapter.identify('user-1', { plan: 'pro' });

    // No new merge event names; the distinct id and retained anon id are unchanged.
    expect(adapter.getDistinctId()).toBe('user-1');
    expect(adapter.getPersistedProperty(ANONYMOUS_DISTINCT_ID_KEY)).toBe(retainedAnon);
    // A traits-only event fired, carrying NO merge-link property.
    expect(capture).toHaveBeenCalledTimes(1);
    const evt = capture.mock.calls[0][0];
    expect(evt.properties).not.toHaveProperty(ANONYMOUS_DISTINCT_ID_KEY);
    expect(evt.properties?.[SET_TRAITS_KEY]).toEqual({ plan: 'pro' });
  });

  test('a bare same-id re-identify with no traits is a no-op (no event emitted)', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });
    adapter.identify('user-1');
    const capture = vi.spyOn(adapter, 'capture');

    adapter.identify('user-1');

    expect(capture).not.toHaveBeenCalled();
  });

  test('a NEW id while ALREADY identified does NOT merge client-side', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });
    adapter.identify('user-1');
    const retainedAnon = adapter.getPersistedProperty(ANONYMOUS_DISTINCT_ID_KEY);
    const capture = vi.spyOn(adapter, 'capture');

    adapter.identify('user-2', { plan: 'pro' });

    // The client-side distinct id does NOT switch to user-2 (no second merge), and
    // the retained anon id is not re-pointed.
    expect(adapter.getDistinctId()).toBe('user-1');
    expect(adapter.getPersistedProperty(ANONYMOUS_DISTINCT_ID_KEY)).toBe(retainedAnon);
    // The traits-only event that fires carries no merge-link property.
    const evt = capture.mock.calls[0][0];
    expect(evt.properties).not.toHaveProperty(ANONYMOUS_DISTINCT_ID_KEY);
  });

  test('traits (mutable) ride set_traits; traitsOnce (first-touch) ride set_traits_once', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });
    const capture = vi.spyOn(adapter, 'capture');

    adapter.identify('user-1', { plan: 'pro' }, { signup_date: '2026-07-08' });

    const merge = capture.mock.calls[0][0];
    expect(merge.properties?.[SET_TRAITS_KEY]).toEqual({ plan: 'pro' });
    expect(merge.properties?.[SET_TRAITS_ONCE_KEY]).toEqual({ signup_date: '2026-07-08' });
  });

  test('on a key collision the mutable trait wins over the first-touch trait (register precedence)', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });
    adapter.identify('user-1');
    const capture = vi.spyOn(adapter, 'capture');

    // Same key in both bags: the mutable value is authoritative on the event.
    adapter.identify('user-1', { plan: 'pro' }, { plan: 'free' });

    const evt = capture.mock.calls[0][0];
    // Both bags are emitted verbatim; the E5 wire-mapper resolves $set over $set_once.
    // The client encodes the precedence by carrying the mutable value on set_traits.
    expect(evt.properties?.[SET_TRAITS_KEY]).toEqual({ plan: 'pro' });
    expect((evt.properties?.[SET_TRAITS_KEY] as Record<string, unknown>).plan).toBe('pro');
  });

  test('the merge event omits an absent trait bag rather than emitting an empty object', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });
    const capture = vi.spyOn(adapter, 'capture');

    adapter.identify('user-1', { plan: 'pro' });

    const merge = capture.mock.calls[0][0];
    expect(merge.properties?.[SET_TRAITS_KEY]).toEqual({ plan: 'pro' });
    expect(merge.properties).not.toHaveProperty(SET_TRAITS_ONCE_KEY);
  });

  test('the trait bag is copied, not aliased — mutating the caller bag after identify does not change the event', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });
    const capture = vi.spyOn(adapter, 'capture');
    const traits = { plan: 'pro' };

    adapter.identify('user-1', traits);
    traits.plan = 'mutated';

    const merge = capture.mock.calls[0][0];
    expect(merge.properties?.[SET_TRAITS_KEY]).toEqual({ plan: 'pro' });
  });

  test('the merge distinct id survives a reload — a merged identity re-reads as ONE id, still identified', () => {
    const key = freshKey();
    new BrowserAdapter({ key, persistence: 'localStorage+cookie' }).setConsentState('granted');
    const writer = new BrowserAdapter({ key, persistence: 'localStorage+cookie' });
    writer.identify('user-1');
    window.dispatchEvent(new Event('beforeunload'));

    const reloaded = new BrowserAdapter({ key, persistence: 'localStorage+cookie' });

    expect(reloaded.getDistinctId()).toBe('user-1');
    expect(reloaded.getPersistedProperty(IDENTITY_STATE_KEY)).toBe('identified');
    // A same-id re-identify after reload does NOT re-merge (still identified).
    const capture = vi.spyOn(reloaded, 'capture');
    reloaded.identify('user-1');
    expect(capture).not.toHaveBeenCalled();
  });

  test('a simulated cross-subdomain journey (S4) + identify keeps ONE merged distinct id', () => {
    // A host-matching cookieDomain truly round-trips the identity cookie (jsdom
    // accepts domain=.localhost), so a second adapter on a different subdomain reads
    // back the merged id — one distinct id across the journey.
    const key = freshKey();
    new BrowserAdapter({ key, persistence: 'cookie' }).setConsentState('granted');

    const first = new BrowserAdapter({ key, persistence: 'cookie', cookieDomain: 'localhost' });
    first.identify('user-1');
    window.dispatchEvent(new Event('beforeunload'));

    const secondSubdomain = new BrowserAdapter({
      key,
      persistence: 'cookie',
      cookieDomain: 'localhost',
    });

    expect(secondSubdomain.getDistinctId()).toBe('user-1');
    expect(secondSubdomain.getPersistedProperty(IDENTITY_STATE_KEY)).toBe('identified');
  });

  test('the merge event flows the normal capture pipeline (session-stamped like any event)', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });
    const pipeline = vi.spyOn(adapter, 'runCapturePipeline');

    adapter.identify('user-1');

    // identify routes through capture() → runCapturePipeline, so E5 transport wraps
    // it uniformly and S8 session stamping already applies.
    expect(pipeline).toHaveBeenCalledTimes(1);
    const stamped = pipeline.mock.results[0].value as NeutralEvent;
    expect(stamped.sessionId).toMatch(UUID_V7);
  });

  test('registered super-props are NOT clobbered by the merge, and the merge-link is not a super-prop', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });
    adapter.register({ plan: 'pro' });

    adapter.identify('user-1');

    // The merge did not disturb the consumer super-prop store.
    expect(adapter.getPersistedProperty('plan')).toBe('pro');
    // The retained anon id is a reserved key, so it never merges into a later event
    // as a consumer super-prop.
    const later = adapter.runCapturePipeline(makeEvent());
    expect(later.properties).not.toHaveProperty(ANONYMOUS_DISTINCT_ID_KEY);
    expect(later.properties).toEqual({ plan: 'pro' });
  });
});

describe('wire-mapping seam — dedupeId → top-level uuid (S8)', () => {
  test('toWireEvent places a captured event dedupeId at the top-level wire uuid', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });
    const event = adapter.runCapturePipeline(makeEvent({ dedupeId: 'dedupe-track-1' }));

    const wire = adapter.toWireEvent(event);

    expect(wire.uuid).toBe('dedupe-track-1');
    // Neutral name in, [WIRE] name out — no `dedupeId` on the wire object.
    expect(wire).not.toHaveProperty('dedupeId');
    // uuid is top-level, never nested in properties.
    expect(wire.properties ?? {}).not.toHaveProperty('uuid');
  });

  test('carries the adapter-stamped merge-event dedupeId (v7) to the wire uuid verbatim', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });
    const capture = vi.spyOn(adapter, 'capture');
    adapter.identify('user-1');
    const mergeEvent = capture.mock.calls[0][0];

    const wire = adapter.toWireEvent(mergeEvent);

    // The merge event's own dedupeId (v7 via generateUuidV7) is carried unchanged.
    expect(wire.uuid).toBe(mergeEvent.dedupeId);
    expect(wire.uuid).toMatch(UUID_V7);
  });

  test('the mapped wire event emits no random $insert_id', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });
    adapter.register({ plan: 'pro' });
    const event = adapter.runCapturePipeline(makeEvent({ properties: { a: 1 } }));

    const wire = adapter.toWireEvent(event);

    expect(wire).not.toHaveProperty('$insert_id');
    expect(wire.properties ?? {}).not.toHaveProperty('$insert_id');
  });
});

describe('reset — clear identity/persistence/session, keep device id (S9)', () => {
  test('regenerates the anonymous id: getDistinctId returns a NEW anon id after reset', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });
    adapter.identify('user-1');
    expect(adapter.getDistinctId()).toBe('user-1');

    adapter.reset();

    const reAnonId = adapter.getDistinctId();
    expect(reAnonId).toMatch(UUID_V7);
    expect(reAnonId).not.toBe('user-1');
    // Identity is cleared: state is back to anonymous, and the retained merge link is gone.
    expect(adapter.getPersistedProperty(IDENTITY_STATE_KEY)).toBe('anonymous');
    expect(adapter.getPersistedProperty(ANONYMOUS_DISTINCT_ID_KEY)).toBeUndefined();
    expect(adapter.getPersistedProperty(DISTINCT_ID_KEY)).toBe(reAnonId);
  });

  test('clears persistence — a registered super-prop does not survive reset', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });
    adapter.register({ plan: 'pro' });
    expect(adapter.getPersistedProperty('plan')).toBe('pro');

    adapter.reset();

    expect(adapter.getPersistedProperty('plan')).toBeUndefined();
  });

  test('clears the session — the next captured event mints a FRESH session id', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });
    const before = adapter.runCapturePipeline(makeEvent()).sessionId;

    adapter.reset();
    const after = adapter.runCapturePipeline(makeEvent()).sessionId;

    expect(after).toMatch(UUID_V7);
    expect(after).not.toBe(before);
  });

  test('KEEPS the device id across reset by default', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });
    const deviceIdBefore = adapter.getPersistedProperty<string>(DEVICE_ID_KEY);

    adapter.reset();

    expect(adapter.getPersistedProperty(DEVICE_ID_KEY)).toBe(deviceIdBefore);
  });

  test('reset({ resetDevice: true }) regenerates the device id', () => {
    const adapter = new BrowserAdapter({ key: freshKey() });
    const deviceIdBefore = adapter.getPersistedProperty<string>(DEVICE_ID_KEY);

    adapter.reset({ resetDevice: true });

    const deviceIdAfter = adapter.getPersistedProperty<string>(DEVICE_ID_KEY);
    expect(deviceIdAfter).toMatch(UUID_V7);
    expect(deviceIdAfter).not.toBe(deviceIdBefore);
  });

  test('a reset actor survives a reload — the re-anonymized identity is persisted, not just cached', () => {
    const key = freshKey();
    new BrowserAdapter({ key, persistence: 'localStorage+cookie' }).setConsentState('granted');
    const writer = new BrowserAdapter({ key, persistence: 'localStorage+cookie' });
    writer.identify('user-1');
    writer.reset();
    const reAnonId = writer.getDistinctId();
    window.dispatchEvent(new Event('beforeunload'));

    const reloaded = new BrowserAdapter({ key, persistence: 'localStorage+cookie' });

    expect(reloaded.getDistinctId()).toBe(reAnonId);
    expect(reloaded.getPersistedProperty(IDENTITY_STATE_KEY)).toBe('anonymous');
  });

  test('reset while opted-out (denied) still clears identity AND writes no cookie', () => {
    const key = freshKey();
    // Durably deny consent, then reconstruct: the adapter is memory-backed (S3 gate),
    // so every write — including reset's — stays out of cookies/localStorage.
    new BrowserAdapter({ key, persistence: 'localStorage+cookie' }).setConsentState('denied');
    const adapter = new BrowserAdapter({ key, persistence: 'localStorage+cookie' });
    adapter.identify('user-1');
    expect(adapter.getDistinctId()).toBe('user-1');

    adapter.reset();
    window.dispatchEvent(new Event('beforeunload'));

    // Identity IS cleared (reset is effective under opt-out — routed to the live adapter).
    const reAnonId = adapter.getDistinctId();
    expect(reAnonId).toMatch(UUID_V7);
    expect(reAnonId).not.toBe('user-1');
    expect(adapter.getPersistedProperty(IDENTITY_STATE_KEY)).toBe('anonymous');
    // The denied posture suppresses every durable write — zero cookies.
    expect(document.cookie).not.toContain(key);
  });
});

describe('bot/crawler suppression at capture time (S7)', () => {
  function stubNavigator(props: { userAgent?: string; webdriver?: boolean }): () => void {
    const restores: (() => void)[] = [];
    for (const [key, value] of Object.entries(props)) {
      const prior = Object.getOwnPropertyDescriptor(window.navigator, key);
      Object.defineProperty(window.navigator, key, { value, configurable: true });
      restores.push(() => {
        if (prior) {
          Object.defineProperty(window.navigator, key, prior);
        } else {
          Reflect.deleteProperty(window.navigator, key);
        }
      });
    }
    return () => restores.forEach((r) => r());
  }

  test('a denylisted user-agent short-circuits capture() BEFORE the pipeline — no event reaches the (S2) queue', () => {
    const restore = stubNavigator({ userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1)' });
    try {
      const adapter = new BrowserAdapter({ key: freshKey() });
      const pipeline = vi.spyOn(adapter, 'runCapturePipeline');

      adapter.capture(makeEvent());

      // The gate sits above the pipeline (and above S2's future enqueue): nothing runs.
      expect(pipeline).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  test('navigator.webdriver flags an automated client even with a clean UA', () => {
    const restore = stubNavigator({ userAgent: 'Mozilla/5.0 Chrome/120', webdriver: true });
    try {
      const adapter = new BrowserAdapter({ key: freshKey() });
      const pipeline = vi.spyOn(adapter, 'runCapturePipeline');

      adapter.capture(makeEvent());

      expect(pipeline).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  test('a non-bot client captures normally — the pipeline runs', () => {
    const restore = stubNavigator({ userAgent: 'Mozilla/5.0 Chrome/120', webdriver: false });
    try {
      const adapter = new BrowserAdapter({ key: freshKey() });
      const pipeline = vi.spyOn(adapter, 'runCapturePipeline');

      adapter.capture(makeEvent());

      expect(pipeline).toHaveBeenCalledOnce();
    } finally {
      restore();
    }
  });

  test('a consumer-supplied denylist extension suppresses a UA the default list misses', () => {
    const restore = stubNavigator({ userAgent: 'Mozilla/5.0 AcmeInternalScanner/3.2', webdriver: false });
    try {
      // Without the extension, this UA captures normally...
      const plain = new BrowserAdapter({ key: freshKey() });
      const plainPipeline = vi.spyOn(plain, 'runCapturePipeline');
      plain.capture(makeEvent());
      expect(plainPipeline).toHaveBeenCalledOnce();

      // ...with the extension, the same UA is now blocked before the pipeline.
      const extended = new BrowserAdapter({
        key: freshKey(),
        blockedUserAgents: ['acmeinternalscanner'],
      });
      const extendedPipeline = vi.spyOn(extended, 'runCapturePipeline');
      extended.capture(makeEvent());
      expect(extendedPipeline).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  test('botFilter:false disables filtering entirely — an otherwise-blocked UA captures normally (bar B)', () => {
    const restore = stubNavigator({ userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1)', webdriver: true });
    try {
      const adapter = new BrowserAdapter({ key: freshKey(), botFilter: false });
      const pipeline = vi.spyOn(adapter, 'runCapturePipeline');

      adapter.capture(makeEvent());

      // Filtering off ⇒ the blocked-and-webdriver client still flows through the pipeline.
      expect(pipeline).toHaveBeenCalledOnce();
    } finally {
      restore();
    }
  });

  test('filtering defaults ON — omitting botFilter still suppresses a blocked UA', () => {
    const restore = stubNavigator({ userAgent: 'Googlebot/2.1', webdriver: false });
    try {
      const adapter = new BrowserAdapter({ key: freshKey() });
      const pipeline = vi.spyOn(adapter, 'runCapturePipeline');

      adapter.capture(makeEvent());

      expect(pipeline).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

describe('batch queue + real delivery (S2)', () => {
  const INGEST = 'https://analytics.example.com';

  // A mock fetch SPI: records every POST and resolves a benign 200 — never a real
  // backend. The adapter's own fetch() is the seam we stub (the E2 neutral primitive).
  type Recorded = { url: string; options: NeutralFetchOptions };
  function mockFetch(adapter: BrowserAdapter): Recorded[] {
    const calls: Recorded[] = [];
    vi.spyOn(adapter, 'fetch').mockImplementation(async (url, options) => {
      calls.push({ url, options });
      return { status: 200, text: async () => '', json: async () => ({}) };
    });
    return calls;
  }

  function batchOf(options: NeutralFetchOptions): Record<string, unknown>[] {
    return (JSON.parse(options.body as string) as { data: Record<string, unknown>[] }).data;
  }

  test('capture enqueues the post-pipeline enriched event — it is no longer dropped', async () => {
    const adapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST, compression: false });
    const calls = mockFetch(adapter);
    adapter.register({ plan: 'pro' });

    adapter.capture(makeEvent({ properties: { a: 1 } }));
    // Not sent yet — buffered until an interval / size trigger or explicit flush.
    expect(calls).toHaveLength(0);

    await adapter.flush();

    expect(calls).toHaveLength(1);
    const [event] = batchOf(calls[0].options);
    // The enriched (super-prop-merged, session-stamped) event rode the wire.
    expect((event.properties as Record<string, unknown>).plan).toBe('pro');
    expect((event.properties as Record<string, unknown>).a).toBe(1);
    expect(typeof event.uuid).toBe('string');
  });

  test('flush() POSTs the data:[] envelope to the S1-resolved ingest URL via the fetch() SPI', async () => {
    const adapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST, compression: false });
    const calls = mockFetch(adapter);

    adapter.capture(makeEvent({ dedupeId: 'd-1' }));
    adapter.capture(makeEvent({ dedupeId: 'd-2' }));
    await adapter.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://analytics.example.com/batch/');
    expect(calls[0].options.method).toBe('POST');
    expect(calls[0].options.headers['Content-Type']).toBe('application/json');
    const data = batchOf(calls[0].options);
    expect(data.map((e) => e.uuid)).toEqual(['d-1', 'd-2']);
  });

  test('each wired event carries an offset (not an absolute timestamp) in the envelope', async () => {
    const adapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST, compression: false });
    const calls = mockFetch(adapter);

    adapter.capture(makeEvent({ timestamp: new Date(Date.now() - 5000) }));
    await adapter.flush();

    const [event] = batchOf(calls[0].options);
    expect(event).not.toHaveProperty('timestamp');
    expect(typeof event.offset).toBe('number');
  });

  test('the interval trigger flushes buffered events without an explicit flush (fake timers)', async () => {
    vi.useFakeTimers();
    const adapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST, flushInterval: 1000, compression: false });
    const calls = mockFetch(adapter);

    adapter.capture(makeEvent({ dedupeId: 'interval-1' }));
    expect(calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1000);

    expect(calls).toHaveLength(1);
    expect(batchOf(calls[0].options)[0].uuid).toBe('interval-1');
  });

  test('the size trigger flushes at flushAt events, before the interval elapses (fake timers)', async () => {
    vi.useFakeTimers();
    const adapter = new BrowserAdapter({
      key: freshKey(),
      ingestHost: INGEST,
      flushInterval: 5000,
      flushAt: 2,
      compression: false,
    });
    const calls = mockFetch(adapter);

    adapter.capture(makeEvent({ dedupeId: 's-1' }));
    expect(calls).toHaveLength(0);
    // The second event hits flushAt=2 — flush fires immediately, no timer wait.
    adapter.capture(makeEvent({ dedupeId: 's-2' }));

    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toHaveLength(1);
    expect(batchOf(calls[0].options).map((e) => e.uuid)).toEqual(['s-1', 's-2']);
  });

  test('a keyed client with no ingestHost buffers but POSTs nothing (no target)', async () => {
    const adapter = new BrowserAdapter({ key: freshKey() });
    const calls = mockFetch(adapter);

    adapter.capture(makeEvent());
    await adapter.flush();

    expect(calls).toHaveLength(0);
  });

  test('optOut (setConsentState denied) DROPS the unsent buffer — no POST fires after opt-out', async () => {
    const adapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST, compression: false });
    const calls = mockFetch(adapter);

    adapter.capture(makeEvent({ dedupeId: 'pre-optout' }));
    adapter.setConsentState('denied');
    await adapter.flush();

    // The buffered event was dropped, not flushed — zero POSTs.
    expect(calls).toHaveLength(0);
  });

  test('optIn (setConsentState granted) does NOT drop the buffer — the E4 regression guard', async () => {
    const adapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST, compression: false });
    const calls = mockFetch(adapter);

    adapter.capture(makeEvent({ dedupeId: 'kept' }));
    adapter.setConsentState('granted');
    await adapter.flush();

    // Granting must not drop already-buffered events — they still flush.
    expect(calls).toHaveLength(1);
    expect(batchOf(calls[0].options)[0].uuid).toBe('kept');
  });

  test('a merge (identify) event flushes with set_traits lifted to a top-level wire key', async () => {
    const adapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST, compression: false });
    const calls = mockFetch(adapter);

    adapter.identify('user-1', { plan: 'pro' });
    await adapter.flush();

    const [merge] = batchOf(calls[0].options);
    expect(merge.event).toBe(MERGE_EVENT);
    // The trait bag is a top-level wire key, and the merge link stays in properties.
    expect(merge.set_traits).toEqual({ plan: 'pro' });
    expect(merge.properties).toHaveProperty(ANONYMOUS_DISTINCT_ID_KEY);
    expect((merge.properties as Record<string, unknown>)).not.toHaveProperty(SET_TRAITS_KEY);
  });

  test('shutdown drains the buffer just like flush', async () => {
    const adapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST, compression: false });
    const calls = mockFetch(adapter);

    adapter.capture(makeEvent({ dedupeId: 'on-shutdown' }));
    await adapter.shutdown();

    expect(calls).toHaveLength(1);
    expect(batchOf(calls[0].options)[0].uuid).toBe('on-shutdown');
  });

  test('the batch envelope / data:[] / offset stay adapter-internal — no wire shape on the neutral surface (bar A)', async () => {
    const adapter: AnalyticsAdapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST, compression: false });
    const calls = mockFetch(adapter as BrowserAdapter);

    // The consumer captures a plain NeutralEvent — it carries NO wire vocabulary
    // (no data:[] envelope, no offset). capture() takes it and returns void.
    const neutralEvent = makeEvent({ dedupeId: 'neutral-1' });
    expect(neutralEvent).not.toHaveProperty('data');
    expect(neutralEvent).not.toHaveProperty('offset');
    expect(adapter.capture(neutralEvent)).toBeUndefined();

    await adapter.flush();

    // The data:[] envelope + timestamp→offset rewrite appear ONLY inside the string
    // body the adapter POSTs — assembled below the neutral SPI, never on a value the
    // neutral surface hands back. The wire shape lives only here, in the transport.
    const parsed = JSON.parse(calls[0].options.body as string) as { data: Record<string, unknown>[] };
    expect(parsed).toHaveProperty('data');
    expect(parsed.data[0]).toHaveProperty('offset');
    // The neutral surface is unchanged: capture/flush are the only transport-facing
    // members, and neither returns nor accepts a wire-shaped value.
    expect(typeof adapter.capture).toBe('function');
    expect(adapter.flush()).toBeInstanceOf(Promise);
  });
});

describe('retry queue with backoff (S3)', () => {
  const INGEST = 'https://analytics.example.com';

  type Recorded = { url: string; options: NeutralFetchOptions };

  // A mock fetch that resolves each POST with the next status from a scripted list
  // (the last status repeats once the list is exhausted). Records every call so the
  // retry re-send count is assertable. status 0 models a network / no-HTTP failure.
  function mockFetchStatuses(adapter: BrowserAdapter, statuses: number[]): Recorded[] {
    const calls: Recorded[] = [];
    let i = 0;
    vi.spyOn(adapter, 'fetch').mockImplementation(async (url, options) => {
      calls.push({ url, options });
      const status = statuses[Math.min(i, statuses.length - 1)];
      i += 1;
      return { status, text: async () => '', json: async () => ({}) };
    });
    return calls;
  }

  test('a 5xx re-enqueues the batch and re-sends after the exponential backoff (fake timers)', async () => {
    vi.useFakeTimers();
    const adapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST, compression: false });
    // First POST 503, then 200 on the retry.
    const calls = mockFetchStatuses(adapter, [503, 200]);

    adapter.capture(makeEvent({ dedupeId: 'r-1' }));
    await adapter.flush();
    // The initial POST fired and failed (503) — exactly one call so far.
    expect(calls).toHaveLength(1);

    // First-retry backoff is base*2**0 = 3000ms with ±50% jitter, so up to 3750ms;
    // the poller ticks every 3000ms. Advance two poll ticks so the retry is due
    // regardless of where jitter landed the delay.
    await vi.advanceTimersByTimeAsync(6000);

    // The retry re-sent the SAME batch — a second POST fired.
    expect(calls).toHaveLength(2);
    expect(batchOf(calls[1].options).map((e) => e.uuid)).toEqual(['r-1']);
  });

  test('a persistent 5xx re-sends on the exponential schedule 3000 → 6000 → 12000 (base*2**n)', async () => {
    vi.useFakeTimers();
    const adapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST, compression: false });
    const calls = mockFetchStatuses(adapter, [503]); // always fails

    adapter.capture(makeEvent({ dedupeId: 'sched' }));
    await adapter.flush();
    expect(calls).toHaveLength(1); // initial POST failed

    // First retry at ~3000ms (attempt 0 backoff, ±50% jitter). Zero jitter is not
    // guaranteed in the adapter's real RetryQueue (it uses Math.random), so advance
    // two poll ticks and assert the re-send COUNT grows one attempt at a time.
    await vi.advanceTimersByTimeAsync(6000);
    expect(calls).toHaveLength(2);

    // The next retry backoff doubles (~6000ms, up to 7500ms with jitter); advance
    // past enough poll ticks to cover it — the schedule keeps re-sending.
    await vi.advanceTimersByTimeAsync(9000);
    expect(calls.length).toBeGreaterThan(2);
  });

  test('a 4xx is NEVER retried — the batch is dropped from the retry queue', async () => {
    vi.useFakeTimers();
    const adapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST, compression: false });
    const calls = mockFetchStatuses(adapter, [400]);

    adapter.capture(makeEvent({ dedupeId: 'perm-reject' }));
    await adapter.flush();
    expect(calls).toHaveLength(1); // the one POST that got the 400

    // No retry is ever scheduled — advancing the clock far past any backoff window
    // fires no further POST, and no retry timer lingers.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(calls).toHaveLength(1);
  });

  test('a 429 (rate-limit, a 4xx) is NOT retried by S3 — rate-limiting is S4, not retry', async () => {
    vi.useFakeTimers();
    const adapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST, compression: false });
    const calls = mockFetchStatuses(adapter, [429]);

    adapter.capture(makeEvent({ dedupeId: 'rl' }));
    await adapter.flush();

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(calls).toHaveLength(1);
  });

  test('a 200 succeeds first time — no retry scheduled', async () => {
    vi.useFakeTimers();
    const adapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST, compression: false });
    const calls = mockFetchStatuses(adapter, [200]);

    adapter.capture(makeEvent({ dedupeId: 'ok' }));
    await adapter.flush();
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(calls).toHaveLength(1);
  });

  test('a network failure (status 0) retries at most 3 times', async () => {
    vi.useFakeTimers();
    const adapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST, compression: false });
    const calls = mockFetchStatuses(adapter, [0]); // always a network failure

    adapter.capture(makeEvent({ dedupeId: 'net' }));
    await adapter.flush();

    // Drain the whole schedule: advance well past the capped backoff repeatedly.
    for (let i = 0; i < 20; i += 1) {
      await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
    }

    // 1 initial POST + 3 retries = 4 total for a status-0 failure.
    expect(calls).toHaveLength(4);
  });

  test('a persistent 5xx retries at most 10 times', async () => {
    vi.useFakeTimers();
    const adapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST, compression: false });
    const calls = mockFetchStatuses(adapter, [500]); // always a 5xx

    adapter.capture(makeEvent({ dedupeId: 'srv' }));
    await adapter.flush();

    for (let i = 0; i < 40; i += 1) {
      await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
    }

    // 1 initial POST + 10 retries = 11 total for a 5xx failure.
    expect(calls).toHaveLength(11);
  });

  test('the retry re-POSTs the SAME data:[] batch (idempotent uuid replayed unchanged)', async () => {
    vi.useFakeTimers();
    const adapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST, compression: false });
    const calls = mockFetchStatuses(adapter, [503, 200]);

    adapter.capture(makeEvent({ dedupeId: 'stable-uuid' }));
    await adapter.flush();
    // Two poll ticks so the first retry (up to 3750ms with jitter) is due.
    await vi.advanceTimersByTimeAsync(6000);

    expect(calls).toHaveLength(2);
    // The retried batch carries the identical top-level uuid — dedupe agrees.
    expect(batchOf(calls[0].options)[0].uuid).toBe('stable-uuid');
    expect(batchOf(calls[1].options)[0].uuid).toBe('stable-uuid');
  });

  test('all retry state stays adapter-internal — no retry config or state on the neutral surface (bar A)', () => {
    const adapter: AnalyticsAdapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST, compression: false });

    // The neutral AnalyticsAdapter surface carries NO retry vocabulary: no schedule,
    // no backoff, no retry-count member. Retry lives entirely inside the adapter.
    const surface = adapter as unknown as Record<string, unknown>;
    expect(surface.scheduleRetry).toBeUndefined();
    expect(surface.retryQueue).toBeDefined(); // it exists, but as a private impl field
    // The private retry queue is not part of the AnalyticsAdapter contract — a second
    // adapter satisfies the same surface without any retry member on the interface.
    const adapterKeys: Array<keyof AnalyticsAdapter> = [
      'capture',
      'identify',
      'flush',
      'shutdown',
      'fetch',
    ];
    for (const key of adapterKeys) {
      expect(typeof adapter[key]).toBe('function');
    }
  });

  function batchOf(options: NeutralFetchOptions): Record<string, unknown>[] {
    return (JSON.parse(options.body as string) as { data: Record<string, unknown>[] }).data;
  }
});

describe('client rate limiter + neutralized back-pressure (S4)', () => {
  const INGEST = 'https://analytics.example.com';

  type Recorded = { url: string; options: NeutralFetchOptions };

  // A mock fetch resolving a benign 200 with an EMPTY body (no back-pressure) —
  // the common case; the token bucket is what's under test here.
  function mockFetch(adapter: BrowserAdapter): Recorded[] {
    const calls: Recorded[] = [];
    vi.spyOn(adapter, 'fetch').mockImplementation(async (url, options) => {
      calls.push({ url, options });
      return { status: 200, text: async () => '', json: async () => ({}) };
    });
    return calls;
  }

  // A mock fetch whose response BODY carries the backend's body-borne back-pressure
  // signal from a scripted list (last entry repeats once exhausted). The adapter's
  // injected interpreter reads this off text() — the neutral response type is
  // unchanged; only the body content models the signal.
  function mockFetchBodies(adapter: BrowserAdapter, bodies: string[]): Recorded[] {
    const calls: Recorded[] = [];
    let i = 0;
    vi.spyOn(adapter, 'fetch').mockImplementation(async (url, options) => {
      calls.push({ url, options });
      const body = bodies[Math.min(i, bodies.length - 1)];
      i += 1;
      return { status: 200, text: async () => body, json: async () => (body ? JSON.parse(body) : {}) };
    });
    return calls;
  }

  function batchOf(options: NeutralFetchOptions): Record<string, unknown>[] {
    return (JSON.parse(options.body as string) as { data: Record<string, unknown>[] }).data;
  }

  test('the token bucket throttles capture/enqueue at the ported burst — the 101st event is dropped before the queue (fake timers)', async () => {
    vi.useFakeTimers();
    const adapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST, compression: false });
    const calls = mockFetch(adapter);

    // Fire 150 events in a tight loop (no time advancing) — only the 100-token burst
    // enters the queue; the rest are dropped at capture, before enqueue.
    for (let i = 0; i < 150; i += 1) {
      adapter.capture(makeEvent({ dedupeId: `burst-${i}` }));
    }
    await adapter.flush();

    // Every POST'd event across all batches — exactly the burst count made it through.
    const delivered = calls.flatMap((c) => batchOf(c.options));
    expect(delivered).toHaveLength(100);
    expect(delivered[0].uuid).toBe('burst-0');
    expect(delivered[99].uuid).toBe('burst-99');
  });

  test('the bucket refills at the ported 10/s rate — 1s of elapsed time re-admits exactly 10 events (fake timers)', async () => {
    vi.useFakeTimers();
    const adapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST, compression: false });
    const calls = mockFetch(adapter);

    // Drain the burst.
    for (let i = 0; i < 100; i += 1) {
      adapter.capture(makeEvent({ dedupeId: `d-${i}` }));
    }
    // Now throttled — further captures are dropped.
    for (let i = 0; i < 50; i += 1) {
      adapter.capture(makeEvent({ dedupeId: `dropped-${i}` }));
    }

    // 1s later, the bucket has refilled 10 tokens — 10 more captures are admitted.
    vi.advanceTimersByTime(1000);
    for (let i = 0; i < 50; i += 1) {
      adapter.capture(makeEvent({ dedupeId: `refill-${i}` }));
    }
    await adapter.flush();

    const uuids = calls.flatMap((c) => batchOf(c.options)).map((e) => e.uuid);
    // 100 from the burst + exactly 10 from the refill = 110; none of the dropped ones.
    expect(uuids).toHaveLength(110);
    expect(uuids.filter((u) => String(u).startsWith('refill-'))).toHaveLength(10);
    expect(uuids.some((u) => String(u).startsWith('dropped-'))).toBe(false);
  });

  test('a below-limit capture rate never throttles — steady traffic flows unimpeded', async () => {
    vi.useFakeTimers();
    const adapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST, compression: false });
    const calls = mockFetch(adapter);

    // 5 events/s for 3s — well under 10/s and the burst — nothing is dropped.
    for (let s = 0; s < 3; s += 1) {
      for (let i = 0; i < 5; i += 1) {
        adapter.capture(makeEvent({ dedupeId: `s${s}-${i}` }));
      }
      vi.advanceTimersByTime(1000);
    }
    await adapter.flush();

    expect(calls.flatMap((c) => batchOf(c.options))).toHaveLength(15);
  });

  test('a body-borne back-pressure signal blocks the affected batch for the cool-off window (fake timers)', async () => {
    vi.useFakeTimers();
    const adapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST, flushAt: 1, compression: false });
    // First POST's body signals back-pressure; every later response is clean.
    const calls = mockFetchBodies(adapter, [JSON.stringify({ quota_limited: ['events'] }), '']);

    // First event flushes (flushAt=1) and its response arms the cool-off.
    adapter.capture(makeEvent({ dedupeId: 'first' }));
    await adapter.flush();
    expect(calls).toHaveLength(1);

    // While cooling off, the next flush's POST is SKIPPED — no new fetch fires.
    adapter.capture(makeEvent({ dedupeId: 'during-cooloff' }));
    await adapter.flush();
    expect(calls).toHaveLength(1);

    // Just short of the 60s window — still cooling off, still skipped.
    vi.advanceTimersByTime(60 * 1000 - 1);
    adapter.capture(makeEvent({ dedupeId: 'still-cooling' }));
    await adapter.flush();
    expect(calls).toHaveLength(1);

    // Past the window — sending resumes; the next flush POSTs again.
    vi.advanceTimersByTime(1);
    adapter.capture(makeEvent({ dedupeId: 'after-cooloff' }));
    await adapter.flush();
    expect(calls).toHaveLength(2);
    expect(batchOf(calls[1].options).map((e) => e.uuid)).toContain('after-cooloff');
  });

  test('a clean response body arms NO cool-off — steady delivery continues (regression of the no-back-pressure path)', async () => {
    vi.useFakeTimers();
    const adapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST, flushAt: 1, compression: false });
    const calls = mockFetchBodies(adapter, ['']); // every response body is empty

    adapter.capture(makeEvent({ dedupeId: 'a' }));
    await adapter.flush();
    adapter.capture(makeEvent({ dedupeId: 'b' }));
    await adapter.flush();

    // No cool-off armed — both POSTs fired.
    expect(calls).toHaveLength(2);
  });

  test('the back-pressure signal is read off the response BODY, not a header — the neutral fetch response type is unchanged (bar A)', async () => {
    vi.useFakeTimers();
    const adapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST, flushAt: 1, compression: false });

    // The response the adapter reads exposes exactly the shipped neutral SPI —
    // status + text() + json(), NO header accessor. The signal is body-borne.
    let readText = false;
    vi.spyOn(adapter, 'fetch').mockImplementation(async () => ({
      status: 200,
      text: async () => {
        readText = true;
        return JSON.stringify({ quota_limited: ['events'] });
      },
      json: async () => ({ quota_limited: ['events'] }),
    }));

    adapter.capture(makeEvent({ dedupeId: 'body-read' }));
    await adapter.flush();

    // The adapter interpreted the signal off text() (the body), not off any header.
    expect(readText).toBe(true);
  });

  test('rate-limit state stays adapter-internal — no back-pressure vocabulary on the neutral surface (bar A)', () => {
    const adapter: AnalyticsAdapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST, compression: false });

    // The neutral AnalyticsAdapter surface carries NO rate-limit / back-pressure
    // member: no quota field, no cool-off, no token-bucket accessor. It all lives
    // inside the adapter behind capture()/flush().
    const surface = adapter as unknown as Record<string, unknown>;
    expect(surface.quota_limited).toBeUndefined();
    expect(surface.isCoolingOff).toBeUndefined();
    expect(surface.consumeToken).toBeUndefined();
    expect(surface.rateLimiter).toBeDefined(); // present, but a private impl field
  });
});

// A hoisted set of spies the mocked ./gzip module delegates to, so individual tests
// can script the native/sync/validation behaviour per case. gunzipSync round-trips
// the shipped bytes back to the original JSON to prove they are real gzip.
const gzipMock = vi.hoisted(() => ({
  isGzipSupported: vi.fn<() => boolean>(),
  gzipCompress: vi.fn<(input: string) => Promise<Uint8Array | null>>(),
  gzipSyncFallback: vi.fn<(input: string) => Uint8Array>(),
}));

vi.mock('./gzip', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./gzip')>();
  return {
    ...actual,
    isGzipSupported: () => gzipMock.isGzipSupported(),
    gzipCompress: (input: string) => gzipMock.gzipCompress(input),
    gzipSyncFallback: (input: string) => gzipMock.gzipSyncFallback(input),
  };
});

// Capture the RAW (url, body, contentType) the adapter hands beaconSend on unload,
// BEFORE any Blob wrapping — jsdom's Blob does not round-trip its own body, so reading
// the events out of the pre-Blob string is the reliable seam. Everything else in
// ./transport (feature detects, keepalive threshold, XHR) delegates to the real module.
const beaconMock = vi.hoisted(() => ({
  calls: [] as { url: string; body: string | Uint8Array; contentType: string }[],
  returns: true as boolean,
}));

vi.mock('./transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./transport')>();
  return {
    ...actual,
    beaconSend: (url: string, body: string | Uint8Array, contentType: string): boolean => {
      beaconMock.calls.push({ url, body, contentType });
      // Also hit the real beacon so the navigator.sendBeacon-presence gate is exercised.
      return actual.beaconSend(url, body, contentType) && beaconMock.returns;
    },
  };
});

describe('gzip compression (S5)', () => {
  const INGEST = 'https://analytics.example.com';
  const GZIP_MAGIC = [0x1f, 0x8b];

  // The real de-branded primitives — used to produce genuine gzip bytes and to
  // round-trip them back, independent of the per-test spies on the module.
  let realGzip: typeof import('./gzip');
  let gunzipSync: typeof import('fflate').gunzipSync;
  let strFromU8: typeof import('fflate').strFromU8;

  beforeAll(async () => {
    realGzip = await vi.importActual<typeof import('./gzip')>('./gzip');
    ({ gunzipSync, strFromU8 } = await import('fflate'));
  });

  beforeEach(() => {
    // Reset call history between cases (the shared config does not auto-clear), then
    // re-apply the default: native supported and producing valid gzip bytes. jsdom's
    // Response/Blob chain can't actually drive the real native CompressionStream path
    // (it returns null there), so the default native mock returns REAL gzip bytes — via
    // the working sync compressor — to stand in for a successful native compression.
    // Individual tests override these before capturing.
    vi.clearAllMocks();
    gzipMock.isGzipSupported.mockReturnValue(true);
    gzipMock.gzipCompress.mockImplementation(async (input) => realGzip.gzipSyncFallback(input));
    gzipMock.gzipSyncFallback.mockImplementation((input) => realGzip.gzipSyncFallback(input));
  });

  afterEach(() => {
    // Uninstall the global-fetch spy so the compressed-path stub never leaks past S5.
    vi.restoreAllMocks();
  });

  // Record the binary POST the adapter makes below the neutral SPI (the compressed
  // path bypasses this.fetch and goes straight to the DOM fetch). The gzip body rides
  // as an ArrayBuffer with the [WIRE] Content-Type in the headers.
  type BinaryCall = { url: string; body: ArrayBuffer; contentType: string | undefined };
  function spyDomFetch(): BinaryCall[] {
    const calls: BinaryCall[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: string | URL | Request, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        calls.push({ url: String(input), body: init?.body as ArrayBuffer, contentType: headers['Content-Type'] });
        return { status: 200, text: async () => '', json: async () => ({}) } as unknown as Response;
      }
    );
    return calls;
  }

  // The uncompressed string path still rides the neutral fetch() SPI — spy it to prove
  // the fallback / toggle-off cases deliver a JSON string, not binary.
  type StringCall = { url: string; options: NeutralFetchOptions };
  function spyNeutralFetch(adapter: BrowserAdapter): StringCall[] {
    const calls: StringCall[] = [];
    vi.spyOn(adapter, 'fetch').mockImplementation(async (url, options) => {
      calls.push({ url, options });
      return { status: 200, text: async () => '', json: async () => ({}) };
    });
    return calls;
  }

  function bodyBytes(call: BinaryCall): Uint8Array {
    return new Uint8Array(call.body);
  }

  test('the batch body is gzipped via the native CompressionStream path when it succeeds — sync fallback not reached', async () => {
    // native (mocked to a successful compression) yields valid gzip bytes.
    const adapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST });
    const domCalls = spyDomFetch();

    adapter.capture(makeEvent({ dedupeId: 'gz-native' }));
    await adapter.flush();

    // The native path ran and its bytes were shipped; the sync fallback was NOT reached.
    expect(gzipMock.gzipCompress).toHaveBeenCalledTimes(1);
    expect(gzipMock.gzipSyncFallback).not.toHaveBeenCalled();
    // Exactly one compressed POST fired below the neutral SPI.
    expect(domCalls).toHaveLength(1);

    const bytes = bodyBytes(domCalls[0]);
    // Real gzip framing, and it round-trips back to the JSON envelope carrying the uuid.
    expect([bytes[0], bytes[1]]).toEqual(GZIP_MAGIC);
    const json = strFromU8(gunzipSync(bytes));
    expect(JSON.parse(json).data[0].uuid).toBe('gz-native');
  });

  test('the gzipped POST sets Content-Type text/plain and the [WIRE] compression/ver/_ query params', async () => {
    const adapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST });
    const domCalls = spyDomFetch();

    adapter.capture(makeEvent({ dedupeId: 'gz-headers' }));
    await adapter.flush();

    expect(domCalls[0].contentType).toBe('text/plain');
    const url = new URL(domCalls[0].url);
    expect(url.searchParams.get('compression')).toBe('gzip-js');
    expect(url.searchParams.get('ver')).toBe('0.0.0');
    expect(url.searchParams.has('_')).toBe(true);
    // The base path is preserved; only [WIRE] params were appended.
    expect(url.origin + url.pathname).toBe('https://analytics.example.com/batch/');
  });

  test('when the native compression yields nothing, the fflate sync fallback compresses the body', async () => {
    // Native returned null (unsupported at send time or a swallowed failure) — the
    // sync fflate fallback must produce the bytes rather than shipping uncompressed.
    gzipMock.gzipCompress.mockResolvedValue(null);
    const adapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST });
    const domCalls = spyDomFetch();

    adapter.capture(makeEvent({ dedupeId: 'gz-fflate' }));
    await adapter.flush();

    // Native yielded null → the sync fflate fallback produced the bytes.
    expect(gzipMock.gzipCompress).toHaveBeenCalledTimes(1);
    expect(gzipMock.gzipSyncFallback).toHaveBeenCalledTimes(1);
    expect(domCalls).toHaveLength(1);

    const bytes = bodyBytes(domCalls[0]);
    expect([bytes[0], bytes[1]]).toEqual(GZIP_MAGIC);
    expect(JSON.parse(strFromU8(gunzipSync(bytes))).data[0].uuid).toBe('gz-fflate');
  });

  test('output validation rejecting the native result falls back to the fflate sync path (not corrupt bytes)', async () => {
    // Model a native path whose output failed validation: gzipCompress swallows it and
    // returns null, exactly as the real validateNativeGzip → catch path does.
    gzipMock.gzipCompress.mockResolvedValue(null);
    const syncSpy = gzipMock.gzipSyncFallback.mockImplementation((input) =>
      realGzip.gzipSyncFallback(input)
    );
    const adapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST });
    const domCalls = spyDomFetch();

    adapter.capture(makeEvent({ dedupeId: 'gz-validate' }));
    await adapter.flush();

    expect(syncSpy).toHaveBeenCalledTimes(1);
    const bytes = bodyBytes(domCalls[0]);
    // Still valid gzip (the fallback), never corrupt bytes.
    expect([bytes[0], bytes[1]]).toEqual(GZIP_MAGIC);
    expect(JSON.parse(strFromU8(gunzipSync(bytes))).data[0].uuid).toBe('gz-validate');
  });

  test('when BOTH native and sync produce non-gzip bytes, delivery falls back to the uncompressed JSON string path', async () => {
    // Both compression paths return garbage that fails the isGzipData guard — the
    // adapter must ship plain JSON via the neutral SPI rather than corrupt bytes.
    gzipMock.gzipCompress.mockResolvedValue(new Uint8Array([0x00, 0x01, 0x02]));
    gzipMock.gzipSyncFallback.mockReturnValue(new Uint8Array([0x00, 0x01, 0x02]));
    const adapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST });
    const stringCalls = spyNeutralFetch(adapter);
    const domCalls = spyDomFetch();

    adapter.capture(makeEvent({ dedupeId: 'gz-bad-both' }));
    await adapter.flush();

    // No binary POST — the uncompressed JSON string went through the neutral SPI.
    expect(domCalls).toHaveLength(0);
    expect(stringCalls).toHaveLength(1);
    expect(stringCalls[0].options.headers['Content-Type']).toBe('application/json');
    expect(stringCalls[0].url).toBe('https://analytics.example.com/batch/');
    const data = (JSON.parse(stringCalls[0].options.body as string) as { data: { uuid: string }[] })
      .data;
    expect(data[0].uuid).toBe('gz-bad-both');
  });

  test('the compression toggle off restores S2 uncompressed JSON POST via the neutral fetch() SPI', async () => {
    const adapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST, compression: false });
    const stringCalls = spyNeutralFetch(adapter);
    const domCalls = spyDomFetch();

    adapter.capture(makeEvent({ dedupeId: 'toggle-off' }));
    await adapter.flush();

    // Compression never ran; the uncompressed S2 path fired unchanged.
    expect(gzipMock.gzipCompress).not.toHaveBeenCalled();
    expect(gzipMock.gzipSyncFallback).not.toHaveBeenCalled();
    expect(domCalls).toHaveLength(0);
    expect(stringCalls).toHaveLength(1);
    expect(stringCalls[0].options.method).toBe('POST');
    expect(stringCalls[0].options.headers['Content-Type']).toBe('application/json');
    // No [WIRE] compression params on the uncompressed path.
    expect(stringCalls[0].url).toBe('https://analytics.example.com/batch/');
    expect(JSON.parse(stringCalls[0].options.body as string).data[0].uuid).toBe('toggle-off');
  });

  test('compression resolves OFF when the native primitive is absent (default-on only where supported)', async () => {
    gzipMock.isGzipSupported.mockReturnValue(false);
    const adapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST });
    const stringCalls = spyNeutralFetch(adapter);
    const domCalls = spyDomFetch();

    adapter.capture(makeEvent({ dedupeId: 'no-primitive' }));
    await adapter.flush();

    // No native support → no compression at all → the plain S2 string path.
    expect(gzipMock.gzipCompress).not.toHaveBeenCalled();
    expect(domCalls).toHaveLength(0);
    expect(stringCalls).toHaveLength(1);
    expect(stringCalls[0].options.headers['Content-Type']).toBe('application/json');
  });

  test('the neutral surface carries NO compression wire vocabulary — the toggle is a plain boolean (bar A)', () => {
    const adapter: AnalyticsAdapter = new BrowserAdapter({ key: freshKey(), ingestHost: INGEST });

    // No wire value / Content-Type / query-param member leaks onto the neutral surface.
    const surface = adapter as unknown as Record<string, unknown>;
    expect(surface.compression).toBeUndefined();
    expect(surface['gzip-js']).toBeUndefined();
    expect(surface.gzipCompress).toBeUndefined();
    // The neutral config field is a plain boolean, not a vendor value.
    const config: AnalyticsConfig = { compression: true };
    expect(typeof config.compression).toBe('boolean');
  });
});

describe('transport selection + keepalive + unload drain (S6)', () => {
  const INGEST = 'https://analytics.example.com';

  // Adapters bind pagehide/visibilitychange/beforeunload on the SHARED jsdom window and
  // stay live until shutdown(). Track every adapter this suite creates so afterEach tears
  // its listeners down — otherwise a stale adapter fires its own unload drain when a later
  // test dispatches a lifecycle event on the same window.
  const liveAdapters: BrowserAdapter[] = [];
  function makeAdapter(options: BrowserAdapterOptions): BrowserAdapter {
    const adapter = new BrowserAdapter(options);
    liveAdapters.push(adapter);
    return adapter;
  }

  // jsdom does NOT implement navigator.sendBeacon, so DEFINE it (the production feature
  // detect then finds it) — a no-op that returns true; the real captured payload is read
  // from beaconMock (the raw pre-Blob body). Returns the beaconMock.calls array.
  type BeaconCall = { url: string; body: string | Uint8Array; contentType: string };
  const beaconCleanups: (() => void)[] = [];
  function spyBeacon(): BeaconCall[] {
    beaconMock.calls.length = 0;
    beaconMock.returns = true;
    const nav = navigator as unknown as { sendBeacon?: (url: string) => boolean };
    const had = 'sendBeacon' in nav;
    const prior = nav.sendBeacon;
    nav.sendBeacon = () => true;
    beaconCleanups.push(() => {
      if (had) {
        nav.sendBeacon = prior;
      } else {
        delete nav.sendBeacon;
      }
    });
    return beaconMock.calls;
  }

  afterEach(() => {
    // Detach every live adapter's page-lifecycle listeners so it doesn't drain on a later
    // test's dispatched unload. Reach the private unbinder directly (no flush side-effect).
    for (const adapter of liveAdapters.splice(0)) {
      (adapter as unknown as { detachUnloadListeners?: () => void }).detachUnloadListeners?.();
    }
    for (const cleanup of beaconCleanups.splice(0)) {
      cleanup();
    }
    beaconMock.calls.length = 0;
  });

  function eventsInBeaconCall(call: BeaconCall): Record<string, unknown>[] {
    // The uncompressed unload body is the JSON `data:[]` envelope string.
    const text = typeof call.body === 'string' ? call.body : '';
    return (JSON.parse(text) as { data: Record<string, unknown>[] }).data;
  }

  // All uuids across every beacon call — used to prove a specific adapter's event drained,
  // tolerant of other-suite adapters still bound to the shared jsdom window (they drain
  // their own — empty — buffers, which never collide with this test's unique dedupeIds).
  function beaconedUuids(beacons: BeaconCall[]): Set<unknown> {
    const uuids = new Set<unknown>();
    for (const beacon of beacons) {
      for (const e of eventsInBeaconCall(beacon)) {
        uuids.add(e.uuid);
      }
    }
    return uuids;
  }

  // --- transport preference: fetch → XHR → sendBeacon by availability ---

  test('the normal POST rides the fetch() SPI when fetch is available (fetch is preferred)', async () => {
    const adapter = makeAdapter({ key: freshKey(), ingestHost: INGEST, compression: false });
    const calls: { url: string; options: NeutralFetchOptions }[] = [];
    vi.spyOn(adapter, 'fetch').mockImplementation(async (url, options) => {
      calls.push({ url, options });
      return { status: 200, text: async () => '', json: async () => ({}) };
    });

    adapter.capture(makeEvent({ dedupeId: 'fetch-pref' }));
    await adapter.flush();

    // fetch present ⇒ delivery went through the neutral fetch() SPI (the fetch branch).
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://analytics.example.com/batch/');
  });

  test('falls back to an XHR POST when fetch is absent at runtime', async () => {
    // Stub fetch out of existence so the transport selection falls to XHR. A fake XHR
    // captures the POST and completes it with a 200.
    const xhrCalls: { method: string; url: string; body: unknown }[] = [];
    class FakeXhr {
      method = '';
      url = '';
      status = 0;
      readyState = 0;
      responseText = '';
      onreadystatechange: (() => void) | null = null;
      open(method: string, url: string): void {
        this.method = method;
        this.url = url;
      }
      setRequestHeader(): void {}
      send(body: unknown): void {
        xhrCalls.push({ method: this.method, url: this.url, body });
        this.status = 200;
        this.readyState = 4;
        this.onreadystatechange?.();
      }
    }
    vi.stubGlobal('fetch', undefined);
    vi.stubGlobal('XMLHttpRequest', FakeXhr);

    const adapter = makeAdapter({ key: freshKey(), ingestHost: INGEST, compression: false });
    // The neutral SPI itself wraps global fetch — spy it to prove it is NOT the path taken
    // (fetch is absent, so the transport must not route through it).
    const spiCalls: unknown[] = [];
    vi.spyOn(adapter, 'fetch').mockImplementation(async (...args) => {
      spiCalls.push(args);
      return { status: 200, text: async () => '', json: async () => ({}) };
    });

    adapter.capture(makeEvent({ dedupeId: 'xhr-fallback' }));
    await adapter.flush();

    expect(xhrCalls).toHaveLength(1);
    expect(xhrCalls[0].method).toBe('POST');
    expect(xhrCalls[0].url).toBe('https://analytics.example.com/batch/');
    // The neutral fetch() SPI branch was NOT taken (fetch absent).
    expect(spiCalls).toHaveLength(0);

    vi.unstubAllGlobals();
  });

  // --- keepalive on fetch POSTs under the ~52 KB cap (binary/DOM-fetch path) ---

  test('sets keepalive on the compressed fetch POST when the body is under the ~52 KB cap', async () => {
    // Drive the compressed (binary) path — the DOM-fetch path where keepalive lives.
    gzipMock.isGzipSupported.mockReturnValue(true);
    const real = await vi.importActual<typeof import('./gzip')>('./gzip');
    gzipMock.gzipCompress.mockImplementation(async (input) => real.gzipSyncFallback(input));
    gzipMock.gzipSyncFallback.mockImplementation((input) => real.gzipSyncFallback(input));

    const inits: RequestInit[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init?: RequestInit) => {
      inits.push(init ?? {});
      return { status: 200, text: async () => '', json: async () => ({}) } as unknown as Response;
    });

    const adapter = makeAdapter({ key: freshKey(), ingestHost: INGEST });
    adapter.capture(makeEvent({ dedupeId: 'ka-small' }));
    await adapter.flush();

    expect(inits).toHaveLength(1);
    // A tiny batch is well under the cap ⇒ keepalive is set on the POST.
    expect(inits[0].keepalive).toBe(true);

    vi.restoreAllMocks();
  });

  test('does NOT set keepalive when the compressed body exceeds the ~52 KB cap', async () => {
    // Model an over-cap compressed body: gzip returns a valid-header buffer larger than
    // the keepalive threshold, so the keepalive flag must be false.
    const oversized = new Uint8Array(64 * 1024);
    oversized[0] = 0x1f;
    oversized[1] = 0x8b;
    gzipMock.isGzipSupported.mockReturnValue(true);
    gzipMock.gzipCompress.mockResolvedValue(oversized);
    gzipMock.gzipSyncFallback.mockReturnValue(oversized);

    const inits: RequestInit[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init?: RequestInit) => {
      inits.push(init ?? {});
      return { status: 200, text: async () => '', json: async () => ({}) } as unknown as Response;
    });

    const adapter = makeAdapter({ key: freshKey(), ingestHost: INGEST });
    adapter.capture(makeEvent({ dedupeId: 'ka-big' }));
    await adapter.flush();

    expect(inits).toHaveLength(1);
    // Over the cap ⇒ keepalive must be off (fetch keepalive errors above 64 KB).
    expect(inits[0].keepalive).toBe(false);

    vi.restoreAllMocks();
  });

  // --- unload drains BOTH queues via sendBeacon ---

  test('unload() beacon-sends the buffered batch-queue events as one data:[] envelope', () => {
    const adapter = makeAdapter({ key: freshKey(), ingestHost: INGEST, compression: false });
    const beacons = spyBeacon();

    // Buffer two events WITHOUT flushing — they sit in the S2 batch queue.
    adapter.capture(makeEvent({ dedupeId: 'leave-1' }));
    adapter.capture(makeEvent({ dedupeId: 'leave-2' }));

    // Direct drain (the architect's unit-invoke seam) — isolates this adapter from any
    // other-suite adapter still listening on the shared window.
    adapter.unload();

    // Exactly one beacon carrying the two buffered events, in order, to the ingest URL.
    expect(beacons).toHaveLength(1);
    expect(beacons[0].url).toBe('https://analytics.example.com/batch/');
    const data = eventsInBeaconCall(beacons[0]);
    expect(data.map((e) => e.uuid)).toEqual(['leave-1', 'leave-2']);

    vi.restoreAllMocks();
  });

  test('a simulated pagehide wires the listener → the adapter drains its buffer via beacon', () => {
    const adapter = makeAdapter({ key: freshKey(), ingestHost: INGEST, compression: false });
    const beacons = spyBeacon();

    adapter.capture(makeEvent({ dedupeId: 'pagehide-wired' }));
    window.dispatchEvent(new Event('pagehide'));

    // The pagehide listener fired this adapter's drain (unique uuid tolerates any other
    // still-bound suite adapters draining their own empty buffers).
    expect(beaconedUuids(beacons).has('pagehide-wired')).toBe(true);

    vi.restoreAllMocks();
  });

  test('a simulated visibilitychange(hidden) wires the listener → the adapter drains via beacon', () => {
    const adapter = makeAdapter({ key: freshKey(), ingestHost: INGEST, compression: false });
    const beacons = spyBeacon();

    adapter.capture(makeEvent({ dedupeId: 'vis-wired' }));

    // jsdom lets us drive document.visibilityState via a defineProperty override.
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(beaconedUuids(beacons).has('vis-wired')).toBe(true);

    vi.restoreAllMocks();
  });

  test('visibilitychange to VISIBLE (not hidden) does NOT drain', () => {
    const adapter = makeAdapter({ key: freshKey(), ingestHost: INGEST, compression: false });
    const beacons = spyBeacon();

    adapter.capture(makeEvent({ dedupeId: 'still-visible' }));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    // The page is still visible — no drain, so this adapter's event was not beaconed.
    expect(beaconedUuids(beacons).has('still-visible')).toBe(false);

    vi.restoreAllMocks();
  });

  test('unload() drains BOTH the batch queue AND the S3 retry queue via sendBeacon', async () => {
    vi.useFakeTimers();
    const adapter = makeAdapter({ key: freshKey(), ingestHost: INGEST, compression: false });
    // First POST fails 503 → the batch re-enqueues into the S3 retry queue.
    vi.spyOn(adapter, 'fetch').mockImplementation(async () => ({
      status: 503,
      text: async () => '',
      json: async () => ({}),
    }));

    adapter.capture(makeEvent({ dedupeId: 'retry-held' }));
    await adapter.flush();

    const beacons = spyBeacon();
    // A separate event is buffered in the batch queue but not yet flushed.
    adapter.capture(makeEvent({ dedupeId: 'batch-held' }));

    // Now unload: BOTH the batch buffer AND the retry queue must beacon-drain.
    adapter.unload();

    const uuids = beaconedUuids(beacons);
    expect(uuids.has('batch-held')).toBe(true); // the S2 batch buffer
    expect(uuids.has('retry-held')).toBe(true); // the S3 retry queue

    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test('the unload drain is idempotent — multiple lifecycle events beacon this adapter once', () => {
    const adapter = makeAdapter({ key: freshKey(), ingestHost: INGEST, compression: false });
    const beacons = spyBeacon();

    adapter.capture(makeEvent({ dedupeId: 'once' }));

    // Fire every lifecycle event a real unload emits — the latch must run the drain once.
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('beforeunload'));
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    // Exactly ONE beacon carried this adapter's event, despite the several events fired.
    const withOnce = beacons.filter((b) =>
      eventsInBeaconCall(b).some((e) => e.uuid === 'once')
    );
    expect(withOnce).toHaveLength(1);

    vi.restoreAllMocks();
  });

  test('shutdown() unbinds the unload listeners so a later unload does not re-drain', async () => {
    const adapter = makeAdapter({ key: freshKey(), ingestHost: INGEST, compression: false });
    const beacons = spyBeacon();

    await adapter.shutdown();
    // After shutdown the buffered-then-unload path must not fire a beacon for this adapter.
    adapter.capture(makeEvent({ dedupeId: 'after-shutdown' }));
    window.dispatchEvent(new Event('pagehide'));

    expect(beaconedUuids(beacons).has('after-shutdown')).toBe(false);

    vi.restoreAllMocks();
  });

  test('the compressed unload beacon uses the SYNC gzip path and carries the [WIRE] compression params', async () => {
    const real = await vi.importActual<typeof import('./gzip')>('./gzip');
    gzipMock.isGzipSupported.mockReturnValue(true);
    // The async native primitive must NOT be used on the beacon path (it can't resolve
    // during teardown); assert only the SYNC fallback produces the beacon body.
    gzipMock.gzipCompress.mockResolvedValue(null);
    gzipMock.gzipSyncFallback.mockImplementation((input) => real.gzipSyncFallback(input));

    const adapter = makeAdapter({ key: freshKey(), ingestHost: INGEST });
    const beacons = spyBeacon();

    adapter.capture(makeEvent({ dedupeId: 'gz-unload' }));
    adapter.unload();

    // Exactly one compressed beacon fired (this adapter is the only one with a buffer).
    expect(beacons).toHaveLength(1);
    // The async native compressor was never awaited on the beacon path — only the SYNC one.
    expect(gzipMock.gzipCompress).not.toHaveBeenCalled();
    expect(gzipMock.gzipSyncFallback).toHaveBeenCalled();
    // The [WIRE] compression params ride the beacon URL (gzip body).
    const url = new URL(beacons[0].url);
    expect(url.searchParams.get('compression')).toBe('gzip-js');
    expect(url.origin + url.pathname).toBe('https://analytics.example.com/batch/');
    // The beacon body is gzip bytes carrying the gzip [WIRE] content type — NOT JSON.
    expect(beacons[0].contentType).toBe('text/plain');
    expect(beacons[0].body).toBeInstanceOf(Uint8Array);
    const bytes = beacons[0].body as Uint8Array;
    expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);

    vi.restoreAllMocks();
  });

  test('a client with no ingestHost drains the buffers on unload but beacons nothing (no target)', () => {
    const adapter = makeAdapter({ key: freshKey(), compression: false });
    const beacons = spyBeacon();

    adapter.capture(makeEvent({ dedupeId: 'no-target' }));
    adapter.unload();

    // No ingest target ⇒ the buffer is drained (not left dangling) but nothing is beaconed.
    expect(beacons).toHaveLength(0);

    vi.restoreAllMocks();
  });

  // --- bar A: transport selection + unload stay adapter-internal ---

  test('the neutral surface carries NO transport-selection / beacon vocabulary (bar A)', () => {
    const adapter: AnalyticsAdapter = makeAdapter({ key: freshKey(), ingestHost: INGEST });
    const surface = adapter as unknown as Record<string, unknown>;

    // No transport choice, keepalive, or beacon knob leaks onto the neutral surface.
    expect(surface.transport).toBeUndefined();
    expect(surface.sendBeacon).toBeUndefined();
    expect(surface.keepalive).toBeUndefined();
    expect(surface.beacon).toBeUndefined();
    // The neutral SPI signature is unchanged — fetch() still takes (url, options).
    expect(adapter.fetch.length).toBe(2);
  });

  test('the neutral NeutralFetchOptions carries no keepalive/transport field (SPI unchanged)', () => {
    // A structural pin: the options object the SPI accepts is exactly method/headers/body.
    const options: NeutralFetchOptions = { method: 'POST', headers: {}, body: '{}' };
    expect(Object.keys(options).sort()).toEqual(['body', 'headers', 'method']);
  });
});
