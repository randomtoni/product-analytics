import { expect, test } from 'vitest';
import { NoopAdapter } from 'analytics-kit';
import { createAnalytics, cryptoRandomId, resolveAdapter } from './create-analytics';
import { BrowserAdapter } from './browser-adapter';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('keyed config resolves the browser adapter', () => {
  expect(resolveAdapter({ key: 'proj-key' })).toBeInstanceOf(BrowserAdapter);
});

test('unkeyed config resolves the NoopAdapter (whole-stack no-op)', () => {
  expect(resolveAdapter({})).toBeInstanceOf(NoopAdapter);
});

test('createAnalytics returns a working provider when keyed', () => {
  const analytics = createAnalytics({ key: 'proj-key' });
  expect(() => analytics.track('x')).not.toThrow();
});

test('createAnalytics returns a working provider when unkeyed (config-only adoption, no library edit)', () => {
  const analytics = createAnalytics({});
  expect(() => {
    analytics.track('x');
    analytics.identify('user-1', { plan: 'pro' });
  }).not.toThrow();
});

test('the browser supplies a crypto-backed generator (a v4, distinct from the identity/session v7)', () => {
  expect(cryptoRandomId()).toMatch(V4);
});

test('the persistence config selects the mode: memory mode persists nothing across a reload', () => {
  const key = 'mode-key-memory';
  resolveAdapter({ key, persistence: 'memory' }).setPersistedProperty('device_id', 'ephemeral');

  const reloaded = resolveAdapter({ key, persistence: 'memory' });

  expect(reloaded.getPersistedProperty('device_id')).toBeUndefined();
});

test('omitting persistence yields the durable default (localStorage+cookie survives a reload)', () => {
  const key = 'mode-key-default';
  resolveAdapter({ key }).setPersistedProperty('device_id', 'durable');
  // A real reload fires the unload flush first, landing the debounced write.
  window.dispatchEvent(new Event('beforeunload'));

  const reloaded = resolveAdapter({ key });

  expect(reloaded.getPersistedProperty('device_id')).toBe('durable');
});
