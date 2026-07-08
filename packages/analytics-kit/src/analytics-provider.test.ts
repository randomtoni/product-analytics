import { expect, expectTypeOf, test } from 'vitest';
import type { AnalyticsAdapter, NeutralFetchOptions, NeutralFetchResponse } from './adapter';
import type { NeutralEvent, NeutralProperties, NeutralTraits } from './neutral-event';
import { AnalyticsProviderImpl, type AnalyticsProvider } from './analytics-provider';
import { createAnalytics } from './create-analytics';
import type { FeatureFlagPort, SessionReplayPort } from './ports';
import type {
  FeatureFlagPort as ExportedFeatureFlagPort,
  SessionReplayPort as ExportedSessionReplayPort,
} from './index';
import * as pkg from './index';

class RecordingAdapter implements AnalyticsAdapter {
  captured: NeutralEvent[] = [];
  identified: Array<{ distinctId: string; traits?: NeutralTraits; traitsOnce?: NeutralTraits }> = [];
  grouped: Array<{ type: string; key: string; traits?: NeutralTraits }> = [];
  aliased: Array<{ previousId: string; distinctId: string }> = [];
  flushed = 0;
  didShutdown = false;
  store = new Map<string, unknown>();
  persistedWrites: Array<{ key: string; value: unknown }> = [];

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
    return {
      status: 200,
      text: async () => `${options.method} ${url}`,
      json: async () => ({ ok: true }),
    };
  }
  getPersistedProperty<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }
  setPersistedProperty<T>(key: string, value: T | null): void {
    this.persistedWrites.push({ key, value });
    if (value === null) {
      this.store.delete(key);
    } else {
      this.store.set(key, value);
    }
  }
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

test('track builds a NeutralEvent and calls adapter.capture exactly once', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.track('x', { a: 1 });

  expect(adapter.captured).toHaveLength(1);
  const [event] = adapter.captured;
  expect(event.event).toBe('x');
  expect(event.properties).toEqual({ a: 1 });
});

test('track stamps a timestamp, a non-empty dedupeId, and a populated distinctId', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.track('x');

  const [event] = adapter.captured;
  expect(event.timestamp).toBeInstanceOf(Date);
  expect(typeof event.dedupeId).toBe('string');
  expect(event.dedupeId.length).toBeGreaterThan(0);
  expect(typeof event.distinctId).toBe('string');
  expect(event.distinctId.length).toBeGreaterThan(0);
});

test('each captured event gets a distinct dedupeId', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.track('x');
  analytics.track('x');

  expect(adapter.captured[0].dedupeId).not.toBe(adapter.captured[1].dedupeId);
});

test('page with a name captures an event under that name', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.page('home', { ref: 'nav' });

  expect(adapter.captured).toHaveLength(1);
  expect(adapter.captured[0].event).toBe('home');
  expect(adapter.captured[0].properties).toEqual({ ref: 'nav' });
});

test('page without a name falls back to a neutral placeholder (no vendor $-token)', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.page();

  expect(adapter.captured).toHaveLength(1);
  const [event] = adapter.captured;
  expect(event.event).toBe('page');
  expect(event.event).not.toContain('$');
  expect(event.timestamp).toBeInstanceOf(Date);
  expect(event.dedupeId.length).toBeGreaterThan(0);
});

test('identify delegates id, traits, and traitsOnce to adapter.identify', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.identify('user-1', { plan: 'pro' }, { firstSeen: 1 });

  expect(adapter.identified).toEqual([
    { distinctId: 'user-1', traits: { plan: 'pro' }, traitsOnce: { firstSeen: 1 } },
  ]);
});

test('identify without traits delegates undefined trait payloads', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.identify('user-1');

  expect(adapter.identified).toEqual([
    { distinctId: 'user-1', traits: undefined, traitsOnce: undefined },
  ]);
});

test('group delegates type, key, and props to adapter.group', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.group('company', 'acme', { seats: 10 });

  expect(adapter.grouped).toEqual([{ type: 'company', key: 'acme', traits: { seats: 10 } }]);
});

test('setTraits routes to the identify set-path when once is falsy', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.setTraits({ plan: 'pro' });

  expect(adapter.identified).toHaveLength(1);
  const [call] = adapter.identified;
  expect(call.traits).toEqual({ plan: 'pro' });
  expect(call.traitsOnce).toBeUndefined();
  expect(call.distinctId.length).toBeGreaterThan(0);
});

test('setTraits routes to the identify set-once-path when once is true', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.setTraits({ plan: 'pro' }, true);

  const [call] = adapter.identified;
  expect(call.traits).toBeUndefined();
  expect(call.traitsOnce).toEqual({ plan: 'pro' });
});

test('flush delegates to adapter.flush and resolves', async () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  await expect(analytics.flush()).resolves.toBeUndefined();
  expect(adapter.flushed).toBe(1);
});

test('shutdown delegates to adapter.shutdown and resolves', async () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  await expect(analytics.shutdown()).resolves.toBeUndefined();
  expect(adapter.didShutdown).toBe(true);
});

test('reset is a no-op skeleton in E2 — it touches no adapter verb', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.reset();

  expect(adapter.captured).toHaveLength(0);
  expect(adapter.identified).toHaveLength(0);
  expect(adapter.grouped).toHaveLength(0);
  expect(adapter.aliased).toHaveLength(0);
  expect(adapter.flushed).toBe(0);
  expect(adapter.didShutdown).toBe(false);
});

test('the adapter field is reassignable so S4/S5 can swap the active delegate', () => {
  const first = new RecordingAdapter();
  const second = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(first);

  (analytics as unknown as { adapter: AnalyticsAdapter }).adapter = second;
  analytics.track('x');

  expect(first.captured).toHaveLength(0);
  expect(second.captured).toHaveLength(1);
});

test('hasOptedOut() defaults to false on a fresh provider', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  expect(analytics.hasOptedOut()).toBe(false);
});

test('after optOut the live spy receives zero capture/identify/group/alias calls; hasOptedOut() is true', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.optOut();
  analytics.track('x');
  analytics.page('home');
  analytics.identify('user-1', { plan: 'pro' });
  analytics.group('company', 'acme');
  analytics.setTraits({ plan: 'pro' });

  expect(adapter.captured).toHaveLength(0);
  expect(adapter.identified).toHaveLength(0);
  expect(adapter.grouped).toHaveLength(0);
  expect(adapter.aliased).toHaveLength(0);
  expect(analytics.hasOptedOut()).toBe(true);
});

test('after optIn delegation to the live spy resumes; hasOptedOut() is false', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.optOut();
  analytics.track('while-opted-out');
  analytics.optIn();
  analytics.track('after-opt-in');
  analytics.identify('user-1', { plan: 'pro' });
  analytics.group('company', 'acme');

  expect(adapter.captured).toHaveLength(1);
  expect(adapter.captured[0].event).toBe('after-opt-in');
  expect(adapter.identified).toHaveLength(1);
  expect(adapter.grouped).toHaveLength(1);
  expect(analytics.hasOptedOut()).toBe(false);
});

test('whole-stack reach: while opted-out no persistence write reaches the live adapter (forward guard)', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.optOut();
  analytics.track('x');
  analytics.identify('user-1', { plan: 'pro' });
  analytics.group('company', 'acme');

  expect(adapter.persistedWrites).toHaveLength(0);
});

test('optOut is idempotent and keeps routing verbs to the no-op', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.optOut();
  analytics.optOut();
  analytics.track('x');

  expect(adapter.captured).toHaveLength(0);
  expect(analytics.hasOptedOut()).toBe(true);
});

test('optIn on a never-opted-out provider keeps delegation live and hasOptedOut() false', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.optIn();
  analytics.track('x');

  expect(adapter.captured).toHaveLength(1);
  expect(analytics.hasOptedOut()).toBe(false);
});

test('the impl class is not exported from the package entrypoint', () => {
  expect('AnalyticsProviderImpl' in pkg).toBe(false);
});

test('AnalyticsProvider exposes exactly the thirteen §1 members (verbs + consent trio + optional capability ports)', () => {
  expectTypeOf<keyof AnalyticsProvider>().toEqualTypeOf<
    | 'track'
    | 'identify'
    | 'page'
    | 'group'
    | 'reset'
    | 'setTraits'
    | 'optIn'
    | 'optOut'
    | 'hasOptedOut'
    | 'flush'
    | 'shutdown'
    | 'flags'
    | 'replay'
  >();
});

test('flags and replay are typed to the capability ports and are optional', () => {
  expectTypeOf<AnalyticsProvider['flags']>().toEqualTypeOf<FeatureFlagPort | undefined>();
  expectTypeOf<AnalyticsProvider['replay']>().toEqualTypeOf<SessionReplayPort | undefined>();
});

test('FeatureFlagPort and SessionReplayPort are exported from the package entrypoint (type-level)', () => {
  expectTypeOf<ExportedFeatureFlagPort>().toEqualTypeOf<FeatureFlagPort>();
  expectTypeOf<ExportedSessionReplayPort>().toEqualTypeOf<SessionReplayPort>();
});

test('flags is undefined on a release-1 provider (optional slot, not adapter-wired)', () => {
  const analytics = createAnalytics({});

  expect(analytics.flags).toBeUndefined();
});

test('replay is undefined on a release-1 provider (optional slot, not adapter-wired)', () => {
  const analytics = createAnalytics({});

  expect(analytics.replay).toBeUndefined();
});

test('optional ports are independent of the capture path — track/identify run while flags/replay stay undefined', () => {
  const analytics = createAnalytics({});

  analytics.track('x');
  analytics.identify('user-1', { plan: 'pro' });

  expect(analytics.flags).toBeUndefined();
  expect(analytics.replay).toBeUndefined();
});

test('AnalyticsProvider method signatures are pinned (compile-time)', () => {
  expectTypeOf<AnalyticsProvider['track']>().toEqualTypeOf<
    (event: string, props?: NeutralProperties) => void
  >();
  expectTypeOf<AnalyticsProvider['identify']>().toEqualTypeOf<
    (id: string, traits?: NeutralTraits, traitsOnce?: NeutralTraits) => void
  >();
  expectTypeOf<AnalyticsProvider['page']>().toEqualTypeOf<
    (name?: string, props?: NeutralProperties) => void
  >();
  expectTypeOf<AnalyticsProvider['group']>().toEqualTypeOf<
    (type: string, key: string, props?: NeutralTraits) => void
  >();
  expectTypeOf<AnalyticsProvider['setTraits']>().toEqualTypeOf<
    (traits: NeutralTraits, once?: boolean) => void
  >();
  expectTypeOf<AnalyticsProvider['reset']>().toEqualTypeOf<() => void>();
  expectTypeOf<AnalyticsProvider['optIn']>().toEqualTypeOf<() => void>();
  expectTypeOf<AnalyticsProvider['optOut']>().toEqualTypeOf<() => void>();
  expectTypeOf<AnalyticsProvider['hasOptedOut']>().toEqualTypeOf<() => boolean>();
  expectTypeOf<AnalyticsProvider['flush']>().returns.toEqualTypeOf<Promise<void>>();
  expectTypeOf<AnalyticsProvider['shutdown']>().returns.toEqualTypeOf<Promise<void>>();
});
