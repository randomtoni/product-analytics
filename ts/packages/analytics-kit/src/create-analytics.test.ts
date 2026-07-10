import { afterEach, expect, expectTypeOf, test, vi } from 'vitest';
import type {
  AnalyticsAdapter,
  ConsentState,
  NeutralFetchOptions,
  NeutralFetchResponse,
} from './adapter';
import type { NeutralEvent, NeutralTraits } from './neutral-event';
import type { AnalyticsProvider, RootAnalytics } from './analytics-provider';
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
  register(): void {}
  unregister(): void {}
  reset(): void {}
  getDistinctId(): string {
    return 'anonymous';
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
    return 'granted';
  }
  setConsentState(): void {}
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

test('createAnalytics returns the widened RootAnalytics return type (compile-time, E6-S8)', () => {
  // Two ordered overloads now: an untyped config resolves through the loose overload to the
  // default RootAnalytics (AnalyticsProvider + context()), accepting an optional adapter as
  // its second parameter. The return type is RootAnalytics, NOT the frozen AnalyticsProvider —
  // context() rides the widened return type, leaving the 15-member interface pin untouched.
  const loose = createAnalytics({});
  expectTypeOf(loose).toEqualTypeOf<RootAnalytics>();
  expectTypeOf(loose).toMatchTypeOf<AnalyticsProvider>();
  expectTypeOf(loose.context).toBeFunction();
  expectTypeOf(createAnalytics).toBeCallableWith({});
  expectTypeOf(createAnalytics).toBeCallableWith({ key: 'abc' });
  expectTypeOf(createAnalytics).parameter(1).toEqualTypeOf<AnalyticsAdapter | undefined>();
});

test('the internal facade class is never exposed through the public barrel', () => {
  expect('AnalyticsProviderImpl' in pkg).toBe(false);
});

test('AnalyticsConfig carries key, taxonomy brand, the allowlist guard fields (E3), the persistence mode (E4), the consent default (E4-S3), the cross-subdomain cookie fields (E4-S4), the session-expiry timeouts (E4-S8), the ingest host/path (E5-S1), the bot-filter switch + denylist extension (E5-S7), the batch flush interval/size (E5-S2), the compression toggle (E5-S5), the per-module enrichment opt-out object (E6-S5), the nested country slot (countrySource + disableGeoip) on it (E6-S6), the top-level autocapture opt-in boolean (E6-S7), and the named contexts + defaultContext for per-context capture profiles (E6-S8), and the feature-flag bootstrap config (E12-S1)', () => {
  expectTypeOf<AnalyticsConfig>().toEqualTypeOf<{
    key?: string;
    taxonomy?: Taxonomy<TaxonomyDecl>;
    allowlist?: string[];
    onViolation?: 'throw' | 'drop-and-error-log';
    persistence?: 'cookie' | 'localStorage+cookie' | 'memory';
    consentDefault?: 'granted' | 'denied';
    cookieDomain?: string;
    crossSubdomainCookie?: boolean;
    sessionIdleTimeoutMs?: number;
    sessionMaxLengthMs?: number;
    ingestHost?: string;
    ingestPath?: string;
    botFilter?: boolean;
    blockedUserAgents?: string[];
    flushInterval?: number;
    flushAt?: number;
    compression?: boolean;
    enrichment?: {
      page?: boolean;
      device?: boolean;
      referrer?: boolean;
      utm?: boolean;
      pageleave?: boolean;
      country?: {
        countrySource?: string | (() => string | undefined);
        disableGeoip?: boolean;
      };
    };
    autocapture?: boolean;
    contexts?: Record<
      string,
      {
        autocapture?: boolean;
        enrichment?: {
          page?: boolean;
          device?: boolean;
          referrer?: boolean;
          utm?: boolean;
          pageleave?: boolean;
          country?: {
            countrySource?: string | (() => string | undefined);
            disableGeoip?: boolean;
          };
        };
      }
    >;
    defaultContext?: string;
    flags?: {
      bootstrap?: {
        flags?: Record<string, string | boolean>;
        payloads?: Record<string, unknown>;
      };
    };
    sessionReplay?: {
      enabled: boolean;
      sampleRate?: number;
      masking?: {
        maskAllInputs?: boolean;
        maskTextSelector?: string;
        blockSelector?: string;
      };
    };
  }>();
  const empty: AnalyticsConfig = {};
  expect(empty).toEqual({});
});

test('SessionReplayConfig is the enable/sample/mask carrier (enabled required, sampleRate + masking optional) and is re-exported (E14-S1)', () => {
  expectTypeOf<pkg.SessionReplayConfig>().toEqualTypeOf<{
    enabled: boolean;
    sampleRate?: number;
    masking?: {
      maskAllInputs?: boolean;
      maskTextSelector?: string;
      blockSelector?: string;
    };
  }>();

  // enabled is required (the opt-in); a config with only masking must NOT type-check as a
  // SessionReplayConfig — pin the required flag by a negative assignability check.
  expectTypeOf<{ masking: { maskAllInputs: true } }>().not.toMatchTypeOf<pkg.SessionReplayConfig>();

  // Fully-populated masking still type-checks (the three neutral CSS/DOM fields).
  const full: pkg.SessionReplayConfig = {
    enabled: true,
    sampleRate: 0.25,
    masking: { maskAllInputs: true, maskTextSelector: '.secret', blockSelector: '.pii' },
  };
  expect(full.masking?.blockSelector).toBe('.pii');
});

test('createAnalytics accepts sessionReplay as a plain type carrier — no seam validation, no sampleRate normalization (E14-S1)', () => {
  // The seam validates NOTHING: an out-of-range sampleRate is accepted verbatim (normalization
  // is the browser recorder's job, S4), and init never throws on it. Mirrors how `flags` config
  // passes straight through the seam untouched.
  expect(() =>
    createAnalytics({ sessionReplay: { enabled: true, sampleRate: 1.7 } })
  ).not.toThrow();
  expect(() =>
    createAnalytics({ sessionReplay: { enabled: true, sampleRate: -3 } })
  ).not.toThrow();
  // A replay-enabled provider is still just the base provider this release — no recorder wired,
  // the replay slot stays undefined (S2 populates it).
  const analytics = createAnalytics({ sessionReplay: { enabled: true } });
  expect(analytics.replay).toBeUndefined();
});
