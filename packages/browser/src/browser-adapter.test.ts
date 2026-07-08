import { expect, test } from 'vitest';
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

test('satisfies the shipped AnalyticsAdapter SPI (structural conformance)', () => {
  const adapter: AnalyticsAdapter = new BrowserAdapter();
  expect(adapter).toBeInstanceOf(BrowserAdapter);
});

test('capture runs without throwing and returns void', () => {
  const adapter = new BrowserAdapter();
  expect(adapter.capture(makeEvent())).toBeUndefined();
});

test('the capture pipeline is a pass-through today — S8 sessionId hook not yet stamping', () => {
  const adapter = new BrowserAdapter();
  const event = makeEvent();

  const result = adapter.runCapturePipeline(event);

  expect(result.sessionId).toBeUndefined();
  expect(result).toEqual(event);
});

test('the capture pipeline preserves an already-set sessionId (S7 super-prop hook not yet merging)', () => {
  const adapter = new BrowserAdapter();
  const event = makeEvent({ sessionId: 'session-1', properties: { a: 1 } });

  const result = adapter.runCapturePipeline(event);

  expect(result.sessionId).toBe('session-1');
  expect(result.properties).toEqual({ a: 1 });
});

test('persistence reads are empty in the skeleton — the store lands in S2', () => {
  const adapter: AnalyticsAdapter = new BrowserAdapter();
  expect(adapter.getPersistedProperty('distinct_id')).toBeUndefined();
});

test('exposes a neutral, non-vendor library id and version', () => {
  const adapter = new BrowserAdapter();
  expect(adapter.getLibraryId()).toBe('analytics-kit-browser');
  expect(adapter.getLibraryVersion()).toBe('0.0.0');
  expect(adapter.getCustomUserAgent()).toBeUndefined();
});

test('flush and shutdown resolve (no transport resource held yet — E5)', async () => {
  const adapter = new BrowserAdapter();
  await expect(adapter.flush()).resolves.toBeUndefined();
  await expect(adapter.shutdown()).resolves.toBeUndefined();
});
