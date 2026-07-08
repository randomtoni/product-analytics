import { expect, test } from 'vitest';
import type { AnalyticsAdapter } from './adapter';
import { NoopAdapter } from './noop-adapter';

test('NoopAdapter structurally satisfies the entire AnalyticsAdapter SPI', () => {
  const adapter: AnalyticsAdapter = new NoopAdapter();
  expect(adapter).toBeInstanceOf(NoopAdapter);
});

test('capture/identify/group/alias are silent no-ops that do not throw', () => {
  const adapter: AnalyticsAdapter = new NoopAdapter();

  expect(() => {
    adapter.capture({ event: 'x', distinctId: 'u', dedupeId: 'd' });
    adapter.identify('u', { plan: 'pro' }, { firstSeen: 1 });
    adapter.group('company', 'acme', { seats: 10 });
    adapter.alias('anon-1', 'u');
  }).not.toThrow();
});

test('flush and shutdown resolve to undefined', async () => {
  const adapter: AnalyticsAdapter = new NoopAdapter();

  await expect(adapter.flush()).resolves.toBeUndefined();
  await expect(adapter.shutdown()).resolves.toBeUndefined();
});

test('fetch resolves a neutral empty response (status 0, empty text, empty json)', async () => {
  const adapter: AnalyticsAdapter = new NoopAdapter();

  const res = await adapter.fetch('https://ingest.example/capture', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });

  expect(res.status).toBe(0);
  await expect(res.text()).resolves.toBe('');
  await expect(res.json()).resolves.toEqual({});
});

test('persistence goes to the void — set is a no-op and get returns undefined (whole-stack)', () => {
  const adapter: AnalyticsAdapter = new NoopAdapter();

  adapter.setPersistedProperty('distinct_id', 'user-1');
  expect(adapter.getPersistedProperty<string>('distinct_id')).toBeUndefined();
});

test('consent reports the safest tri-state — denied — and setConsentState is an inert no-op', () => {
  const adapter: AnalyticsAdapter = new NoopAdapter();

  expect(adapter.getConsentState()).toBe('denied');
  // A no-op write cannot flip the reported state — the null-object captures nothing regardless.
  adapter.setConsentState('granted');
  expect(adapter.getConsentState()).toBe('denied');
});

test('client-identity getters return neutral placeholders (no vendor token)', () => {
  const adapter: AnalyticsAdapter = new NoopAdapter();

  const id = adapter.getLibraryId();
  const version = adapter.getLibraryVersion();

  expect(id).toBe('analytics-kit');
  expect(id.length).toBeGreaterThan(0);
  expect(version).toBe('0.0.0');
  expect(adapter.getCustomUserAgent()).toBeUndefined();
});

test('NoopAdapter carries no `disabled` flag — the no-op is the null-object, not a boolean', () => {
  const adapter = new NoopAdapter();

  expect('disabled' in adapter).toBe(false);
});
