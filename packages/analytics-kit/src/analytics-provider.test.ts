import { expect, expectTypeOf, test } from 'vitest';
import type {
  AnalyticsAdapter,
  ConsentState,
  NeutralFetchOptions,
  NeutralFetchResponse,
  RegisterOptions,
  ResetOptions,
} from './adapter';
import type { NeutralEvent, NeutralProperties, NeutralTraits } from './neutral-event';
import {
  AnalyticsProviderImpl,
  type AnalyticsProvider,
  type RootAnalytics,
  type ScopedAnalytics,
} from './analytics-provider';
import { createAnalytics } from './create-analytics';
import { defineTaxonomy, type ShapeOf } from './taxonomy';
import type { FeatureFlagPort, SessionReplayPort } from './ports';
import type {
  FeatureFlagPort as ExportedFeatureFlagPort,
  SessionReplayPort as ExportedSessionReplayPort,
  RootAnalytics as ExportedRootAnalytics,
  ScopedAnalytics as ExportedScopedAnalytics,
} from './index';
import * as pkg from './index';

class RecordingAdapter implements AnalyticsAdapter {
  captured: NeutralEvent[] = [];
  identified: Array<{ distinctId: string; traits?: NeutralTraits; traitsOnce?: NeutralTraits }> = [];
  grouped: Array<{ type: string; key: string; traits?: NeutralTraits }> = [];
  aliased: Array<{ previousId: string; distinctId: string }> = [];
  registered: Array<{ props: NeutralProperties; options?: RegisterOptions }> = [];
  unregistered: string[] = [];
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
  register(props: NeutralProperties, options?: RegisterOptions): void {
    this.registered.push({ props, options });
  }
  unregister(key: string): void {
    this.unregistered.push(key);
  }
  resets: Array<ResetOptions | undefined> = [];
  reset(options?: ResetOptions): void {
    this.resets.push(options);
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

test('a NAMED page stamps the neutral isPageView marker while keeping the router name (E6-S2 PART A)', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.page('/dashboard', { ref: 'nav' });

  const [event] = adapter.captured;
  // The event NAME is the router path — but the marker, not the name, identifies a pageview.
  expect(event.event).toBe('/dashboard');
  expect(event.isPageView).toBe(true);
});

test('a NAMELESS page also stamps the neutral isPageView marker (E6-S2 PART A)', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.page();

  expect(adapter.captured[0].isPageView).toBe(true);
});

test('track does NOT stamp the isPageView marker — only the page() path does (E6-S2 PART A)', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.track('purchase', { amount: 9 });

  // The marker is absent on a plain track event (presence-only: never set false either).
  expect(adapter.captured[0].isPageView).toBeUndefined();
  expect('isPageView' in adapter.captured[0]).toBe(false);
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

test('register delegates the props bag to adapter.register with no options by default', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.register({ plan: 'pro' });

  expect(adapter.registered).toEqual([{ props: { plan: 'pro' }, options: undefined }]);
});

test('register threads the collapsed once flag through to adapter.register', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.register({ plan: 'pro' }, { once: true });

  expect(adapter.registered).toEqual([{ props: { plan: 'pro' }, options: { once: true } }]);
});

test('unregister delegates the single key to adapter.unregister', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.unregister('plan');

  expect(adapter.unregistered).toEqual(['plan']);
});

test('register-while-pending-hits-liveAdapter: an opted-out register/unregister reaches the LIVE adapter, not the no-op', () => {
  const adapter = new RecordingAdapter();
  // Resolve OPTED-OUT: pending consent with no consentDefault 'granted' ⇒ fail-safe opt-out.
  adapter.consentState = 'pending';
  const analytics = new AnalyticsProviderImpl(adapter);
  expect(analytics.hasOptedOut()).toBe(true);

  analytics.register({ plan: 'pro' });
  analytics.register({ firstSeen: 1 }, { once: true });
  analytics.unregister('plan');

  // Registration is a persistence op, not a capture op: it routes to the LIVE adapter
  // (like reset), so the value reaches its store — under pending that store is memory-
  // backed, retained in memory to survive a later opt-in promotion. The no-op-swap never
  // discarded it.
  expect(adapter.registered).toEqual([
    { props: { plan: 'pro' }, options: undefined },
    { props: { firstSeen: 1 }, options: { once: true } },
  ]);
  expect(adapter.unregistered).toEqual(['plan']);
});

test('a DENIED client register reaches the LIVE adapter (retained in memory) yet the facade emits/captures nothing', () => {
  const adapter = new RecordingAdapter();
  adapter.consentState = 'denied';
  const analytics = new AnalyticsProviderImpl(adapter);
  expect(analytics.hasOptedOut()).toBe(true);

  analytics.register({ plan: 'pro' });
  analytics.track('x');
  analytics.page('home');

  // Denied: register still reaches the live adapter (memory-retained; the adapter's own
  // consent posture keeps it from persisting/transmitting) — but no capture is emitted.
  expect(adapter.registered).toEqual([{ props: { plan: 'pro' }, options: undefined }]);
  expect(adapter.captured).toHaveLength(0);
});

test('the allowlist gate STILL fires on the pending register path — an off-list key throws (not bypassed by the live route)', () => {
  const adapter = new RecordingAdapter();
  adapter.consentState = 'pending';
  const analytics = new AnalyticsProviderImpl(adapter, ['plan'], 'throw');
  expect(analytics.hasOptedOut()).toBe(true);

  // The E3 allowlist gate sits ABOVE the live route: an off-list super-prop is rejected
  // on the pending path exactly as on the granted path — the live route does not bypass it.
  expect(() => analytics.register({ country: 'US' })).toThrow(/allowlist/);
  expect(() => analytics.unregister('country')).toThrow(/allowlist/);
  expect(adapter.registered).toHaveLength(0);
  expect(adapter.unregistered).toHaveLength(0);
});

test("an off-list pending register under 'drop-and-error-log' drops without reaching the live adapter", () => {
  const adapter = new RecordingAdapter();
  adapter.consentState = 'pending';
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]): void => {
    errors.push(args);
  };
  try {
    const analytics = new AnalyticsProviderImpl(adapter, ['plan'], 'drop-and-error-log');

    analytics.register({ country: 'US' });

    // Dropped at the gate ⇒ never reaches the live adapter's store, even though the route
    // is now the live adapter.
    expect(adapter.registered).toHaveLength(0);
    expect(errors.length).toBeGreaterThan(0);
  } finally {
    console.error = original;
  }
});

test('an on-allowlist pending register reaches the live adapter (gate passes, then the live route stores it)', () => {
  const adapter = new RecordingAdapter();
  adapter.consentState = 'pending';
  const analytics = new AnalyticsProviderImpl(adapter, ['country'], 'throw');

  analytics.register({ country: 'US' });

  expect(adapter.registered).toEqual([{ props: { country: 'US' }, options: undefined }]);
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

test('reset() delegates to liveAdapter.reset — with the options bag and with none (E4-S9)', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.reset();
  analytics.reset({ resetDevice: true });

  expect(adapter.resets).toEqual([undefined, { resetDevice: true }]);
  // The delegated verb is the SPI reset — no capture / identify side effect.
  expect(adapter.captured).toHaveLength(0);
  expect(adapter.identified).toHaveLength(0);
});

test('reset() routes to the LIVE adapter while opted out — clears identity even when the no-op is active', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.optOut();
  analytics.reset();

  // Routed to liveAdapter, not the consent-swapped no-op: a logout during opt-out
  // still reaches the real adapter (whose consent posture suppresses any write).
  expect(adapter.resets).toEqual([undefined]);
  expect(analytics.hasOptedOut()).toBe(true);
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
  // setTraits routes through currentDistinctId(); the resolver must consult the LIVE adapter.
  analytics.setTraits({ plan: 'pro' });

  expect(adapter.distinctIdReads).toBeGreaterThan(before);
  // FIX #1: setTraits is a PERSISTENCE verb — under opt-out it now routes to the LIVE adapter
  // (not the consent-swapped no-op) so the trait persistence survives; the resolved distinct id
  // is the live one, never the no-op's 'anonymous'. On the real BrowserAdapter the emitted
  // traits EVENT self-suppresses; here the pure spy only records the routing.
  expect(adapter.identified).toEqual([
    { distinctId: 'live-actor-42', traits: { plan: 'pro' }, traitsOnce: undefined },
  ]);
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

test('after optOut the PURE-CAPTURE verbs hit the no-op (zero captures); hasOptedOut() is true', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.optOut();
  analytics.track('x');
  analytics.page('home');

  // track/page are pure capture — they MUST be swap-suppressed under opt-out (routed to the
  // no-op), so the live spy records nothing.
  expect(adapter.captured).toHaveLength(0);
  expect(adapter.aliased).toHaveLength(0);
  expect(analytics.hasOptedOut()).toBe(true);
});

test('FIX #1: after optOut the PERSISTENCE verbs (identify/group/setTraits) reach the LIVE adapter, not the no-op', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.optOut();
  analytics.identify('user-1', { plan: 'pro' });
  analytics.group('company', 'acme');
  analytics.setTraits({ tier: 'gold' });

  // These carry persistence (identity merge / $groups membership / person traits). Under
  // opt-out they route to the LIVE adapter so the persistence survives the opt-out swap and
  // promotes to durable on opt-in — the data-loss bug this fix closes. On the real
  // BrowserAdapter the emitted event self-suppresses inside captureSuppressed(); the pure spy
  // here records only the routing (it does not model that suppression).
  expect(adapter.identified).toEqual([
    { distinctId: 'user-1', traits: { plan: 'pro' }, traitsOnce: undefined },
    { distinctId: 'anonymous', traits: { tier: 'gold' }, traitsOnce: undefined },
  ]);
  expect(adapter.grouped).toEqual([{ type: 'company', key: 'acme', traits: undefined }]);
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

test('FIX #1 routing split: while opted-out capture verbs hit the no-op but persistence verbs reach the live adapter (forward guard)', () => {
  const adapter = new RecordingAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.optOut();
  analytics.track('x');
  analytics.identify('user-1', { plan: 'pro' });
  analytics.group('company', 'acme');

  // The pure-capture track was routed to the no-op: nothing captured on the live spy.
  expect(adapter.captured).toHaveLength(0);
  // The persistence-bearing identify/group reached the LIVE adapter (data survives opt-out).
  expect(adapter.identified).toEqual([
    { distinctId: 'user-1', traits: { plan: 'pro' }, traitsOnce: undefined },
  ]);
  expect(adapter.grouped).toEqual([{ type: 'company', key: 'acme', traits: undefined }]);
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

test('AnalyticsProvider exposes exactly the fifteen §1 members (verbs + super-prop pair + consent trio + optional capability ports)', () => {
  expectTypeOf<keyof AnalyticsProvider>().toEqualTypeOf<
    | 'track'
    | 'identify'
    | 'page'
    | 'group'
    | 'reset'
    | 'setTraits'
    | 'register'
    | 'unregister'
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
  // Collapsed once-flag super-prop shape: register(props, { once? }) + unregister(key).
  expectTypeOf<AnalyticsProvider['register']>().toEqualTypeOf<
    (props: NeutralProperties, options?: { once?: boolean }) => void
  >();
  expectTypeOf<AnalyticsProvider['register']>().toBeCallableWith({ plan: 'pro' });
  expectTypeOf<AnalyticsProvider['register']>().toBeCallableWith({ plan: 'pro' }, { once: true });
  expectTypeOf<AnalyticsProvider['unregister']>().toEqualTypeOf<(key: string) => void>();
  expectTypeOf<AnalyticsProvider['page']>().toEqualTypeOf<
    (name?: string, props?: NeutralProperties) => void
  >();
  // Widened additively (E4-S9): optional resetDevice flag; zero-arg callers still compile.
  expectTypeOf<AnalyticsProvider['reset']>().toEqualTypeOf<
    (options?: { resetDevice?: boolean }) => void
  >();
  expectTypeOf<AnalyticsProvider['reset']>().toBeCallableWith();
  expectTypeOf<AnalyticsProvider['reset']>().toBeCallableWith({ resetDevice: true });
  expectTypeOf<AnalyticsProvider['optIn']>().toEqualTypeOf<() => void>();
  expectTypeOf<AnalyticsProvider['optOut']>().toEqualTypeOf<() => void>();
  expectTypeOf<AnalyticsProvider['hasOptedOut']>().toEqualTypeOf<() => boolean>();
  expectTypeOf<AnalyticsProvider['flush']>().returns.toEqualTypeOf<Promise<void>>();
  expectTypeOf<AnalyticsProvider['shutdown']>().returns.toEqualTypeOf<Promise<void>>();
});

// --- E6-S8: per-context capture profiles — RootAnalytics + ScopedAnalytics pins ---

test('RootAnalytics exposes the frozen fifteen PLUS context — the widened return type (E6-S8)', () => {
  // The new pin: context() rides RootAnalytics, NOT the frozen AnalyticsProvider. The
  // 15-member `keyof AnalyticsProvider` pin above must stay untouched — this is a SEPARATE
  // pin proving the widening happened on the return type only.
  expectTypeOf<keyof RootAnalytics>().toEqualTypeOf<
    | 'track'
    | 'identify'
    | 'page'
    | 'group'
    | 'reset'
    | 'setTraits'
    | 'register'
    | 'unregister'
    | 'optIn'
    | 'optOut'
    | 'hasOptedOut'
    | 'flush'
    | 'shutdown'
    | 'flags'
    | 'replay'
    | 'context'
  >();
  expectTypeOf<RootAnalytics['context']>().toEqualTypeOf<(name: string) => ScopedAnalytics>();
});

test('ScopedAnalytics exposes ONLY the three capture verbs — narrower than AnalyticsProvider (E6-S8)', () => {
  // The LOCKED narrowing: a scoped view carries capture verbs only. Identity/consent/
  // lifecycle verbs are absent — offering them on a per-context handle is a footgun.
  expectTypeOf<keyof ScopedAnalytics>().toEqualTypeOf<'track' | 'page' | 'group'>();
});

test('ScopedAnalytics carries the SAME taxonomy-typed signatures as the root (E6-S8)', () => {
  type TX = ShapeOf<
    ReturnType<
      typeof defineTaxonomy<{
        events: { purchased: { amount: 'number' } };
        groups: { company: { seats: 'number' } };
        page: { section: 'string' };
      }>
    >['decl']
  >;
  // page uses S1's tightened taxonomy page shape identically on both surfaces (NOT a loose
  // NeutralProperties one); track/group carry the same taxonomy generics.
  expectTypeOf<ScopedAnalytics<TX>['page']>().toEqualTypeOf<RootAnalytics<TX>['page']>();
  expectTypeOf<ScopedAnalytics<TX>['track']>().toEqualTypeOf<RootAnalytics<TX>['track']>();
  expectTypeOf<ScopedAnalytics<TX>['group']>().toEqualTypeOf<RootAnalytics<TX>['group']>();
  // The scoped page type-checks a consumer's declared page props (section: string).
  expectTypeOf<ScopedAnalytics<TX>['page']>().toBeCallableWith('home', { section: 'hero' });
  expectTypeOf<ScopedAnalytics<TX>['track']>().toBeCallableWith('purchased', { amount: 9 });
});

test('the scoped view is a strict compile-time narrowing — identity/lifecycle verbs do NOT exist on it (E6-S8)', () => {
  const analytics = createAnalytics({});
  const scoped = analytics.context('marketing');

  // The three capture verbs are present and callable at runtime.
  expect(typeof scoped.track).toBe('function');
  expect(typeof scoped.page).toBe('function');
  expect(typeof scoped.group).toBe('function');

  // Compile-time narrowing: the identity/consent/lifecycle verbs are NOT on the scoped type.
  // Kept in a never-invoked closure so the @ts-expect-error assertions run at typecheck only
  // (calling a missing method would throw at runtime — the narrowing is a type fact, not a
  // runtime one). If any of these verbs is ever added to ScopedAnalytics, the @ts-expect-error
  // goes unused and the build fails loudly.
  const _narrowing = (): void => {
    // @ts-expect-error identify is a shared-root verb, absent on the scoped view
    scoped.identify('user-1');
    // @ts-expect-error reset operates on the shared core, not a per-context handle
    scoped.reset();
    // @ts-expect-error optOut is a consent verb on the root only
    scoped.optOut();
    // @ts-expect-error flush drains the shared transport, not a scoped concern
    scoped.flush();
    // @ts-expect-error shutdown tears down the shared core
    scoped.shutdown();
  };
  void _narrowing;
});

test('RootAnalytics and ScopedAnalytics are exported from the package entrypoint (type-level)', () => {
  expectTypeOf<ExportedRootAnalytics>().toEqualTypeOf<RootAnalytics>();
  expectTypeOf<ExportedScopedAnalytics>().toEqualTypeOf<ScopedAnalytics>();
});

test('the frozen AnalyticsProvider pin is untouched — context is NOT a member of it (E6-S8 discipline)', () => {
  // Belt-and-braces alongside the :619 fifteen-member pin: assert context() did NOT leak
  // onto AnalyticsProvider. If a future edit adds it there, this fails loudly.
  expectTypeOf<AnalyticsProvider>().not.toHaveProperty('context');
});

test('context(name) returns a working scoped view that shares the root distinct id + adapter (E6-S8)', () => {
  const adapter = new RecordingAdapter();
  adapter.distinctId = 'shared-anon-id';
  const analytics = createAnalytics({}, adapter) as RootAnalytics;

  const marketing = analytics.context('marketing');
  const app = analytics.context('app');

  marketing.track('viewed_ad');
  app.track('opened_app');

  expect(adapter.captured).toHaveLength(2);
  // Both contexts capture under the ONE shared distinct id — cross-context stitching.
  expect(adapter.captured[0].distinctId).toBe('shared-anon-id');
  expect(adapter.captured[1].distinctId).toBe('shared-anon-id');
  expect(adapter.captured[0].event).toBe('viewed_ad');
  expect(adapter.captured[1].event).toBe('opened_app');
});

test('a named context stamps its resolved enrichment profile on the minted event; the root does not (E6-S8)', () => {
  const adapter = new RecordingAdapter();
  const analytics = createAnalytics(
    { contexts: { marketing: { enrichment: { device: false, utm: false } } } },
    adapter
  ) as RootAnalytics;

  analytics.context('marketing').track('viewed_ad');
  analytics.track('root_event');

  const [scopedEvent, rootEvent] = adapter.captured;
  expect(scopedEvent.enrichmentProfile).toEqual({
    page: undefined,
    device: false,
    referrer: undefined,
    utm: false,
    disableGeoip: undefined,
  });
  // A root capture carries NO override — the adapter falls back to its own config.
  expect(rootEvent.enrichmentProfile).toBeUndefined();
});

test('an unknown context name yields a scoped view with no enrichment override (E6-S8)', () => {
  const adapter = new RecordingAdapter();
  const analytics = createAnalytics({}, adapter) as RootAnalytics;

  analytics.context('does-not-exist').track('x');

  expect(adapter.captured).toHaveLength(1);
  expect(adapter.captured[0].enrichmentProfile).toBeUndefined();
});

test('a context with only autocapture (no enrichment) carries no per-event override (E6-S8)', () => {
  const adapter = new RecordingAdapter();
  const analytics = createAnalytics(
    { contexts: { app: { autocapture: true } } },
    adapter
  ) as RootAnalytics;

  analytics.context('app').track('opened');

  expect(adapter.captured[0].enrichmentProfile).toBeUndefined();
});

test('a scoped page() stamps the pageview marker AND the enrichment profile (E6-S8)', () => {
  const adapter = new RecordingAdapter();
  const analytics = createAnalytics(
    { contexts: { marketing: { enrichment: { page: false } } } },
    adapter
  ) as RootAnalytics;

  analytics.context('marketing').page('landing');

  const event = adapter.captured[0];
  expect(event.isPageView).toBe(true);
  expect(event.event).toBe('landing');
  expect(event.enrichmentProfile).toEqual({
    page: false,
    device: undefined,
    referrer: undefined,
    utm: undefined,
    disableGeoip: undefined,
  });
});

test('a scoped group() routes to the shared adapter group path (no per-event enrichment) (E6-S8)', () => {
  const adapter = new RecordingAdapter();
  const analytics = createAnalytics(
    { contexts: { marketing: { enrichment: { device: false } } } },
    adapter
  ) as RootAnalytics;

  analytics.context('marketing').group('company', 'acme', { seats: 5 });

  expect(adapter.grouped).toEqual([{ type: 'company', key: 'acme', traits: { seats: 5 } }]);
});

test('a scoped track under a restrictive allowlist gates identically to the root (E6-S8)', () => {
  const adapter = new RecordingAdapter();
  const analytics = createAnalytics(
    { allowlist: ['plan'], contexts: { marketing: {} } },
    adapter
  ) as RootAnalytics;

  // An off-list prop through the scoped view throws exactly as a root track would — the
  // scoped path reuses the SAME E3 gate, and no capture reaches the adapter.
  expect(() => analytics.context('marketing').track('x', { forbidden: 1 })).toThrow(/allowlist/);
  expect(adapter.captured).toHaveLength(0);
});

test('a scoped capture while opted-out routes to the no-op, minting nothing on the live adapter (E6-S8)', () => {
  const adapter = new RecordingAdapter();
  const analytics = createAnalytics({}, adapter) as RootAnalytics;

  analytics.optOut();
  analytics.context('marketing').track('x');

  // The consent-swap applies to scoped captures too — the live adapter records nothing.
  expect(adapter.captured).toHaveLength(0);
});

test('FIX #1: a scoped context(name).group() while opted-out reaches the LIVE adapter (groupWithProfile is persistence)', () => {
  const adapter = new RecordingAdapter();
  const analytics = createAnalytics(
    { contexts: { marketing: { enrichment: { device: false } } } },
    adapter
  ) as RootAnalytics;

  analytics.optOut();
  analytics.context('marketing').group('company', 'acme', { seats: 5 });

  // groupWithProfile carries the membership super-prop (persistence): under opt-out it routes
  // to the LIVE adapter, exactly like the root group(), so the $groups membership survives the
  // opt-out swap. (The architect flagged this scoped path; the review missed it.)
  expect(adapter.grouped).toEqual([{ type: 'company', key: 'acme', traits: { seats: 5 } }]);
});

test('FIX #1: when GRANTED the persistence verbs are unchanged — identify/group/setTraits still reach the live adapter', () => {
  const adapter = new RecordingAdapter();
  adapter.consentState = 'granted';
  const analytics = new AnalyticsProviderImpl(adapter);

  // Granted ⇒ this.adapter === liveAdapter, so the routing change is a no-op here: the verbs
  // reach the live adapter as they always did (regression guard that the fix touched only the
  // opt-out swap, not the granted path).
  analytics.identify('user-1', { plan: 'pro' });
  analytics.group('company', 'acme', { seats: 3 });
  analytics.setTraits({ tier: 'gold' });

  expect(adapter.identified).toEqual([
    { distinctId: 'user-1', traits: { plan: 'pro' }, traitsOnce: undefined },
    { distinctId: 'anonymous', traits: { tier: 'gold' }, traitsOnce: undefined },
  ]);
  expect(adapter.grouped).toEqual([{ type: 'company', key: 'acme', traits: { seats: 3 } }]);
});
