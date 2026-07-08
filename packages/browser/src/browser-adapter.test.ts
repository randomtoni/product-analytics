import { describe, expect, test } from 'vitest';
import type { AnalyticsAdapter, NeutralEvent } from 'analytics-kit';
import { BrowserAdapter } from './browser-adapter';

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

test('a fresh store reads back nothing before anything is written', () => {
  const adapter: AnalyticsAdapter = new BrowserAdapter({ key: freshKey() });
  expect(adapter.getPersistedProperty('distinct_id')).toBeUndefined();
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
    new BrowserAdapter({ key, persistence }).setPersistedProperty('device_id', 'dev-durable');
    // A real reload fires the unload flush first, landing the debounced write.
    window.dispatchEvent(new Event('beforeunload'));

    const reloaded = new BrowserAdapter({ key, persistence });

    expect(reloaded.getPersistedProperty('device_id')).toBe('dev-durable');
  }
});

test('memory mode persists nothing across a fresh store instance', () => {
  const key = freshKey();
  new BrowserAdapter({ key, persistence: 'memory' }).setPersistedProperty('device_id', 'dev-vanishes');
  window.dispatchEvent(new Event('beforeunload'));

  const reloaded = new BrowserAdapter({ key, persistence: 'memory' });

  expect(reloaded.getPersistedProperty('device_id')).toBeUndefined();
});
