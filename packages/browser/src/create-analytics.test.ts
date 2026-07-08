import { expect, test } from 'vitest';
import { NoopAdapter } from 'analytics-kit';
import { createAnalytics, cryptoRandomId, resolveAdapter } from './create-analytics';
import { BrowserAdapter } from './browser-adapter';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
  // A non-identity key: identity keys are re-minted at construction, so this
  // probes a custom prop that nothing re-seeds — proving memory mode is ephemeral.
  resolveAdapter({ key, persistence: 'memory' }).setPersistedProperty('custom_prop', 'ephemeral');

  const reloaded = resolveAdapter({ key, persistence: 'memory' });

  expect(reloaded.getPersistedProperty('custom_prop')).toBeUndefined();
});

test('a keyed client with no consent policy is opted-out by default (fail-safe)', () => {
  const analytics = createAnalytics({ key: 'no-consent-policy-key' });

  expect(analytics.hasOptedOut()).toBe(true);
});

test('an opted-out-by-default keyed adapter still resolves a truthful minted distinct id', () => {
  const analytics = createAnalytics({ key: 'opted-out-truthful-key' });
  // Fail-safe opt-out is the default with no consent policy...
  expect(analytics.hasOptedOut()).toBe(true);

  // ...yet the live adapter (identity is orthogonal to consent) still mints a real
  // UUIDv7 distinct id — the facade reads liveAdapter.getDistinctId(), not the no-op.
  const adapter = resolveAdapter({ key: 'opted-out-truthful-key' });
  expect(adapter.getDistinctId()).toMatch(V7);
  expect(adapter.getDistinctId()).not.toBe('anonymous');
});

test("consentDefault 'granted' + pending: capture runs, yet cookies stay suppressed until an explicit grant", () => {
  const key = 'consent-default-granted-key';
  const analytics = createAnalytics({ key, consentDefault: 'granted' });

  // consentDefault resolves the pending state so capture runs at the facade...
  expect(analytics.hasOptedOut()).toBe(false);
  expect(() => analytics.track('x')).not.toThrow();

  // ...but the adapter's durable consent is still pending, so no cookies are written.
  window.dispatchEvent(new Event('beforeunload'));
  expect(document.cookie).not.toContain(key);
});

test('pointing ingestHost at two different first-party origins resolves two different URLs (bar B: config only, zero library change)', () => {
  const a = resolveAdapter({ key: 'ingest-a', ingestHost: 'https://a.example.com' });
  const b = resolveAdapter({ key: 'ingest-b', ingestHost: 'https://b.example.com' });

  expect(a).toBeInstanceOf(BrowserAdapter);
  expect(b).toBeInstanceOf(BrowserAdapter);
  const urlA = (a as BrowserAdapter).ingestUrl();
  const urlB = (b as BrowserAdapter).ingestUrl();

  expect(urlA).toBe('https://a.example.com/batch/');
  expect(urlB).toBe('https://b.example.com/batch/');
  expect(urlA).not.toBe(urlB);
});

test('ingestPath threads through config to override the wire path on the resolved URL', () => {
  const adapter = resolveAdapter({
    key: 'ingest-path',
    ingestHost: 'https://analytics.example.com',
    ingestPath: '/ingest/',
  }) as BrowserAdapter;

  expect(adapter.ingestUrl()).toBe('https://analytics.example.com/ingest/');
});

test('a keyed client with no ingestHost has no resolved ingest URL (no vendor-host default)', () => {
  const adapter = resolveAdapter({ key: 'no-ingest-host' }) as BrowserAdapter;

  expect(adapter.ingestUrl()).toBeUndefined();
});

test('omitting persistence yields the durable default (localStorage+cookie survives a reload)', () => {
  const key = 'mode-key-default';
  // Persistence is gated on consent (S3): grant durably before the durable write.
  resolveAdapter({ key }).setConsentState('granted');
  const writer = resolveAdapter({ key });
  writer.setPersistedProperty('device_id', 'durable');
  // A real reload fires the unload flush first, landing the debounced write.
  window.dispatchEvent(new Event('beforeunload'));

  const reloaded = resolveAdapter({ key });

  expect(reloaded.getPersistedProperty('device_id')).toBe('durable');
});
