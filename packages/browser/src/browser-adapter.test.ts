import { describe, expect, test } from 'vitest';
import type { AnalyticsAdapter, NeutralEvent } from 'analytics-kit';
import { BrowserAdapter } from './browser-adapter';
import { DEVICE_ID_KEY, DISTINCT_ID_KEY, IDENTITY_STATE_KEY } from './persistence-keys';

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

test('satisfies the shipped AnalyticsAdapter SPI (structural conformance)', () => {
  const adapter: AnalyticsAdapter = new BrowserAdapter({ key: freshKey() });
  expect(adapter).toBeInstanceOf(BrowserAdapter);
});

test('capture runs without throwing and returns void', () => {
  const adapter = new BrowserAdapter({ key: freshKey() });
  expect(adapter.capture(makeEvent())).toBeUndefined();
});

test('the capture pipeline is a pass-through today — S8 sessionId hook not yet stamping', () => {
  const adapter = new BrowserAdapter({ key: freshKey() });
  const event = makeEvent();

  const result = adapter.runCapturePipeline(event);

  expect(result.sessionId).toBeUndefined();
  expect(result).toEqual(event);
});

test('the capture pipeline preserves an already-set sessionId (S7 super-prop hook not yet merging)', () => {
  const adapter = new BrowserAdapter({ key: freshKey() });
  const event = makeEvent({ sessionId: 'session-1', properties: { a: 1 } });

  const result = adapter.runCapturePipeline(event);

  expect(result.sessionId).toBe('session-1');
  expect(result.properties).toEqual({ a: 1 });
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
