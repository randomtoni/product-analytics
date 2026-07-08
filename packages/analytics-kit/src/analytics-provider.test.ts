import { expect, expectTypeOf, test } from 'vitest';
import type {
  AnalyticsAdapter,
  ConsentState,
  NeutralFetchOptions,
  NeutralFetchResponse,
} from './adapter';
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
  consentWrites: ConsentState[] = [];
  consentState: ConsentState = 'granted';
  distinctId = 'anonymous';
  distinctIdReads = 0;

  capture(event: NeutralEvent): void {
    this.captured.push(event);
  }
  identify(distinctId: string, traits?: NeutralTraits, traitsOnce?: NeutralTraits): void {
    this.identified.push({ distinctId, traits, traitsOnce });
  }
  getDistinctId(): string {
    this.distinctIdReads += 1;
    return this.distinctId;
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
  getConsentState(): ConsentState {
    return this.consentState;
  }
  setConsentState(state: ConsentState): void {
    this.consentWrites.push(state);
    this.consentState = state;
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

test('installAdapter swaps the active delegate via the single derivation path', () => {
  const first = new RecordingAdapter();
  const second = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(first);

  analytics.installAdapter(second);
  analytics.track('x');

  expect(first.captured).toHaveLength(0);
  expect(second.captured).toHaveLength(1);
});

test('installAdapter then optOut then optIn delegates to the newly installed live adapter (no stale ref)', () => {
  const first = new RecordingAdapter();
  const second = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(first);

  analytics.installAdapter(second);
  analytics.optOut();
  analytics.track('while-opted-out');
  analytics.optIn();
  analytics.track('after-opt-in');

  expect(first.captured).toHaveLength(0);
  expect(second.captured).toHaveLength(1);
  expect(second.captured[0].event).toBe('after-opt-in');
});

test('flush routes to the live adapter even while opted-out (E2-S5 shutdown-leak closed)', async () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.optOut();
  await expect(analytics.flush()).resolves.toBeUndefined();

  expect(adapter.flushed).toBe(1);
});

test('shutdown routes to the live adapter even while opted-out (E2-S5 shutdown-leak closed)', async () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.optOut();
  await expect(analytics.shutdown()).resolves.toBeUndefined();

  expect(adapter.didShutdown).toBe(true);
});

test('the facade stamps the distinct id resolved from the live adapter (getDistinctId delegation)', () => {
  const adapter = new RecordingAdapter();
  adapter.distinctId = 'live-actor-42';
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.track('x');

  expect(adapter.captured[0].distinctId).toBe('live-actor-42');
});

test('while opted-out the resolver still reads the live adapter (truthful id, not the no-op anonymous)', () => {
  const adapter = new RecordingAdapter();
  adapter.distinctId = 'live-actor-42';
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.optOut();
  const before = adapter.distinctIdReads;
  // setTraits routes through currentDistinctId(); capture is inert under opt-out,
  // but the resolver must still consult the LIVE adapter — never the no-op.
  analytics.setTraits({ plan: 'pro' });

  expect(adapter.distinctIdReads).toBeGreaterThan(before);
  // Inert: nothing recorded on the live adapter (routed through the no-op),
  // yet the live adapter's resolver — not the no-op's 'anonymous' — was consulted.
  expect(adapter.identified).toHaveLength(0);
});

test('generateUuid is injectable via the facade constructor and stamps dedupeId', () => {
  const adapter = new RecordingAdapter();
  let n = 0;
  const analytics = new AnalyticsProviderImpl(adapter, undefined, undefined, () => `fixed-${n++}`);

  analytics.track('x');
  analytics.track('y');

  expect(adapter.captured[0].dedupeId).toBe('fixed-0');
  expect(adapter.captured[1].dedupeId).toBe('fixed-1');
});

test('createAnalytics threads deps.generateUuid through to the facade dedupeId', () => {
  const adapter = new RecordingAdapter();
  const analytics = createAnalytics({}, adapter, { generateUuid: () => 'injected' });

  analytics.track('x');

  expect(adapter.captured[0].dedupeId).toBe('injected');
});

test('without an injected generator the seam Math.random v4 default still stamps a dedupeId', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.track('x');

  expect(adapter.captured[0].dedupeId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
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

test('the facade seeds optedOut from a durable denied consent state at startup', () => {
  const adapter = new RecordingAdapter();
  adapter.consentState = 'denied';

  const analytics = new AnalyticsProviderImpl(adapter);

  expect(analytics.hasOptedOut()).toBe(true);
  analytics.track('x');
  expect(adapter.captured).toHaveLength(0);
});

test('a granted consent state seeds optedOut false and capture reaches the live adapter', () => {
  const adapter = new RecordingAdapter();
  adapter.consentState = 'granted';

  const analytics = new AnalyticsProviderImpl(adapter);

  expect(analytics.hasOptedOut()).toBe(false);
  analytics.track('x');
  expect(adapter.captured).toHaveLength(1);
});

test('pending with consentDefault UNSET resolves to opted-out — the fail-safe default', () => {
  const adapter = new RecordingAdapter();
  adapter.consentState = 'pending';

  const analytics = new AnalyticsProviderImpl(adapter);

  expect(analytics.hasOptedOut()).toBe(true);
  analytics.track('x');
  expect(adapter.captured).toHaveLength(0);
});

test("pending with consentDefault 'granted' resolves to capture-runs (opt-in-by-default knob)", () => {
  const adapter = new RecordingAdapter();
  adapter.consentState = 'pending';

  const analytics = new AnalyticsProviderImpl(adapter, undefined, undefined, undefined, 'granted');

  expect(analytics.hasOptedOut()).toBe(false);
  analytics.track('x');
  expect(adapter.captured).toHaveLength(1);
});

test("pending with consentDefault 'denied' resolves to opted-out (explicit opt-out-by-default)", () => {
  const adapter = new RecordingAdapter();
  adapter.consentState = 'pending';

  const analytics = new AnalyticsProviderImpl(adapter, undefined, undefined, undefined, 'denied');

  expect(analytics.hasOptedOut()).toBe(true);
});

test('optOut persists the durable decision via setConsentState(denied) on the live adapter', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.optOut();

  expect(adapter.consentWrites).toEqual(['denied']);
  expect(adapter.consentState).toBe('denied');
});

test('optIn persists the durable decision via setConsentState(granted) on the live adapter', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.optOut();
  analytics.optIn();

  expect(adapter.consentWrites).toEqual(['denied', 'granted']);
  expect(adapter.consentState).toBe('granted');
});

test('optOut drops rather than flushes — it never calls the live adapter flush', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.optOut();

  expect(adapter.flushed).toBe(0);
});

test('hasOptedOut reflects the durable state after a reconstruct against the same adapter', () => {
  const adapter = new RecordingAdapter();
  const first = new AnalyticsProviderImpl(adapter);
  first.optOut();

  // A reconstruct (reload) re-seeds from the durable decision the adapter now holds.
  const reconstructed = new AnalyticsProviderImpl(adapter);

  expect(reconstructed.hasOptedOut()).toBe(true);
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
  // track and group are now generic over the taxonomy (E3); on the loose default they keep the
  // E2 surface — pin that via callability + return type.
  expectTypeOf<AnalyticsProvider['track']>().toBeCallableWith('x');
  expectTypeOf<AnalyticsProvider['track']>().toBeCallableWith('x', { a: 1 });
  expectTypeOf<AnalyticsProvider['track']>().returns.toEqualTypeOf<void>();
  expectTypeOf<AnalyticsProvider['group']>().toBeCallableWith('company', 'acme');
  expectTypeOf<AnalyticsProvider['group']>().toBeCallableWith('company', 'acme', { seats: 10 });
  expectTypeOf<AnalyticsProvider['group']>().returns.toEqualTypeOf<void>();
  // identify and setTraits now take Partial<TX['traits']> (loose default → Partial<NeutralTraits>).
  expectTypeOf<AnalyticsProvider['identify']>().toEqualTypeOf<
    (id: string, traits?: Partial<NeutralTraits>, traitsOnce?: Partial<NeutralTraits>) => void
  >();
  expectTypeOf<AnalyticsProvider['setTraits']>().toEqualTypeOf<
    (traits: Partial<NeutralTraits>, once?: boolean) => void
  >();
  expectTypeOf<AnalyticsProvider['page']>().toEqualTypeOf<
    (name?: string, props?: NeutralProperties) => void
  >();
  expectTypeOf<AnalyticsProvider['reset']>().toEqualTypeOf<() => void>();
  expectTypeOf<AnalyticsProvider['optIn']>().toEqualTypeOf<() => void>();
  expectTypeOf<AnalyticsProvider['optOut']>().toEqualTypeOf<() => void>();
  expectTypeOf<AnalyticsProvider['hasOptedOut']>().toEqualTypeOf<() => boolean>();
  expectTypeOf<AnalyticsProvider['flush']>().returns.toEqualTypeOf<Promise<void>>();
  expectTypeOf<AnalyticsProvider['shutdown']>().returns.toEqualTypeOf<Promise<void>>();
});
