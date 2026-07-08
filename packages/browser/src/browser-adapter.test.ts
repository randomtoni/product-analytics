import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AnalyticsAdapter, NeutralEvent } from 'analytics-kit';
import { BrowserAdapter } from './browser-adapter';
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
