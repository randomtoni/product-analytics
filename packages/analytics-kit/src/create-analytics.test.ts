import { afterEach, expect, expectTypeOf, test, vi } from 'vitest';
import type { AnalyticsAdapter, NeutralFetchOptions, NeutralFetchResponse } from './adapter';
import type { NeutralEvent, NeutralTraits } from './neutral-event';
import type { AnalyticsProvider } from './analytics-provider';
import { createAnalytics, type AnalyticsConfig } from './create-analytics';
import type { Taxonomy, TaxonomyDecl } from './taxonomy';
import { NoopAdapter } from './noop-adapter';
import * as pkg from './index';

class RecordingAdapter implements AnalyticsAdapter {
  captured: NeutralEvent[] = [];
  identified: Array<{ distinctId: string; traits?: NeutralTraits; traitsOnce?: NeutralTraits }> = [];
  grouped: Array<{ type: string; key: string; traits?: NeutralTraits }> = [];
  aliased: Array<{ previousId: string; distinctId: string }> = [];
  flushed = 0;
  didShutdown = false;

  capture(event: NeutralEvent): void {
    this.captured.push(event);
  }
  identify(distinctId: string, traits?: NeutralTraits, traitsOnce?: NeutralTraits): void {
    this.identified.push({ distinctId, traits, traitsOnce });
  }
  group(type: string, key: string, traits?: NeutralTraits): void {
    this.grouped.push({ type, key, traits });
  }
  alias(previousId: string, distinctId: string): void {
    this.aliased.push({ previousId, distinctId });
  }
  async flush(): Promise<void> {
    this.flushed += 1;
  }
  async shutdown(): Promise<void> {
    this.didShutdown = true;
  }
  async fetch(url: string, options: NeutralFetchOptions): Promise<NeutralFetchResponse> {
    return { status: 200, text: async () => `${options.method} ${url}`, json: async () => ({}) };
  }
  getPersistedProperty<T>(): T | undefined {
    return undefined;
  }
  setPersistedProperty(): void {}
  getLibraryId(): string {
    return 'analytics-kit';
  }
  getLibraryVersion(): string {
    return '0.0.0';
  }
  getCustomUserAgent(): string | undefined {
    return undefined;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

test('createAnalytics({}) returns a working AnalyticsProvider by config alone (bar B)', () => {
  const analytics = createAnalytics({});

  for (const method of [
    'track',
    'identify',
    'page',
    'group',
    'reset',
    'setTraits',
    'flush',
    'shutdown',
  ] as const) {
    expect(typeof analytics[method]).toBe('function');
  }
});

test('createAnalytics({}) is whole-stack silent — nothing hits the wire, nothing persists', async () => {
  const fetchSpy = vi.spyOn(NoopAdapter.prototype, 'fetch');
  const persistSpy = vi.spyOn(NoopAdapter.prototype, 'setPersistedProperty');

  const analytics = createAnalytics({});
  analytics.track('signed_up', { plan: 'pro' });
  analytics.page('home');
  analytics.identify('user-1', { plan: 'pro' });
  analytics.group('company', 'acme');
  analytics.setTraits({ theme: 'dark' });
  await analytics.flush();
  await analytics.shutdown();

  expect(fetchSpy).not.toHaveBeenCalled();
  expect(persistSpy).not.toHaveBeenCalled();
});

test('an unkeyed provider silently swallows captures (no throw, no observable effect)', () => {
  const analytics = createAnalytics({});

  expect(() => analytics.track('x', { a: 1 })).not.toThrow();
});

test('createAnalytics(config, adapter) wires the facade to the supplied adapter and delegates', async () => {
  const adapter = new RecordingAdapter();
  const analytics = createAnalytics({ key: 'abc' }, adapter);

  analytics.track('signed_up', { plan: 'pro' });
  analytics.identify('user-1', { plan: 'pro' });
  analytics.group('company', 'acme', { seats: 10 });
  await analytics.flush();
  await analytics.shutdown();

  expect(adapter.captured).toHaveLength(1);
  expect(adapter.captured[0].event).toBe('signed_up');
  expect(adapter.captured[0].properties).toEqual({ plan: 'pro' });
  expect(adapter.identified).toEqual([
    { distinctId: 'user-1', traits: { plan: 'pro' }, traitsOnce: undefined },
  ]);
  expect(adapter.grouped).toEqual([{ type: 'company', key: 'acme', traits: { seats: 10 } }]);
  expect(adapter.flushed).toBe(1);
  expect(adapter.didShutdown).toBe(true);
});

test('a supplied adapter wins even when the config is unkeyed (generic machinery)', () => {
  const adapter = new RecordingAdapter();
  const analytics = createAnalytics({}, adapter);

  analytics.track('x');

  expect(adapter.captured).toHaveLength(1);
});

test('a keyed config with no adapter still falls back to the NoopAdapter in E2 (no target to select)', async () => {
  const fetchSpy = vi.spyOn(NoopAdapter.prototype, 'fetch');

  const analytics = createAnalytics({ key: 'abc' });
  analytics.track('x');
  await analytics.flush();

  expect(fetchSpy).not.toHaveBeenCalled();
});

test('createAnalytics returns the public AnalyticsProvider interface (compile-time)', () => {
  // Two ordered overloads now: an untyped config resolves through the loose overload to the
  // default AnalyticsProvider, accepting an optional adapter as its second parameter.
  const loose = createAnalytics({});
  expectTypeOf(loose).toEqualTypeOf<AnalyticsProvider>();
  expectTypeOf(createAnalytics).toBeCallableWith({});
  expectTypeOf(createAnalytics).toBeCallableWith({ key: 'abc' });
  expectTypeOf(createAnalytics).parameter(1).toEqualTypeOf<AnalyticsAdapter | undefined>();
});

test('the internal facade class is never exposed through the public barrel', () => {
  expect('AnalyticsProviderImpl' in pkg).toBe(false);
});

test('AnalyticsConfig carries an optional key plus the optional taxonomy brand (E3)', () => {
  expectTypeOf<AnalyticsConfig>().toEqualTypeOf<{
    key?: string;
    taxonomy?: Taxonomy<TaxonomyDecl>;
  }>();
  const empty: AnalyticsConfig = {};
  expect(empty).toEqual({});
});
