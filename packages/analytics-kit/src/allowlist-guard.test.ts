import { afterEach, expect, test, vi } from 'vitest';
import type {
  AnalyticsAdapter,
  ConsentState,
  NeutralFetchOptions,
  NeutralFetchResponse,
} from './adapter';
import type { NeutralEvent, NeutralTraits } from './neutral-event';
import { AnalyticsProviderImpl } from './analytics-provider';
import { createAnalytics } from './create-analytics';

class SpyAdapter implements AnalyticsAdapter {
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

function spyConsoleError() {
  const c = (globalThis as { console: { error: (...args: unknown[]) => void } }).console;
  return vi.spyOn(c, 'error').mockImplementation(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
});

test('off-list track prop throws by default and names the offending key', () => {
  const adapter = new SpyAdapter();
  const analytics = new AnalyticsProviderImpl(adapter, ['onListKey']);

  expect(() => analytics.track('e', { offListKey: 1 })).toThrow(/offListKey/);
  expect(adapter.captured).toHaveLength(0);
});

test('on-list track prop passes and reaches adapter.capture', () => {
  const adapter = new SpyAdapter();
  const analytics = new AnalyticsProviderImpl(adapter, ['onListKey']);

  analytics.track('e', { onListKey: 1 });

  expect(adapter.captured).toHaveLength(1);
  expect(adapter.captured[0].properties).toEqual({ onListKey: 1 });
});

test('drop-and-error-log drops the event, surfaces the violation via console.error, no throw', () => {
  const errorSpy = spyConsoleError();
  const adapter = new SpyAdapter();
  const analytics = new AnalyticsProviderImpl(adapter, ['onListKey'], 'drop-and-error-log');

  expect(() => analytics.track('e', { offListKey: 1 })).not.toThrow();

  expect(adapter.captured).toHaveLength(0);
  expect(errorSpy).toHaveBeenCalledTimes(1);
  expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('offListKey'));
});

test('the guard is pre-adapter: a rejected identify never reaches adapter.identify', () => {
  const adapter = new SpyAdapter();
  const analytics = new AnalyticsProviderImpl(adapter, ['plan']);

  expect(() => analytics.identify('user-1', { ssn: '123' })).toThrow(/ssn/);
  expect(adapter.identified).toHaveLength(0);
});

test('the guard is pre-adapter: a rejected group never reaches adapter.group', () => {
  const adapter = new SpyAdapter();
  const analytics = new AnalyticsProviderImpl(adapter, ['seats']);

  expect(() => analytics.group('company', 'acme', { revenue: 1 })).toThrow(/revenue/);
  expect(adapter.grouped).toHaveLength(0);
});

test('page props are gated like track; the page name is not a gated key', () => {
  const adapter = new SpyAdapter();
  const analytics = new AnalyticsProviderImpl(adapter, ['ref']);

  // name 'home' is event identity — not on the allowlist, yet the on-list prop passes
  analytics.page('home', { ref: 'nav' });
  expect(adapter.captured).toHaveLength(1);

  expect(() => analytics.page('home', { secret: 1 })).toThrow(/secret/);
  expect(adapter.captured).toHaveLength(1);
});

test('group props are gated; the group type and key are not gated keys', () => {
  const adapter = new SpyAdapter();
  const analytics = new AnalyticsProviderImpl(adapter, ['seats']);

  // type 'company' and key 'acme' are identity — not on the allowlist, yet the on-list prop passes
  analytics.group('company', 'acme', { seats: 10 });
  expect(adapter.grouped).toHaveLength(1);

  expect(() => analytics.group('company', 'acme', { revenue: 1 })).toThrow(/revenue/);
});

test('setTraits traits are gated like track', () => {
  const adapter = new SpyAdapter();
  const analytics = new AnalyticsProviderImpl(adapter, ['plan']);

  analytics.setTraits({ plan: 'pro' });
  expect(adapter.identified).toHaveLength(1);

  expect(() => analytics.setTraits({ ssn: '123' })).toThrow(/ssn/);
});

test('identify gates BOTH traits and traitsOnce; the distinct id is not a gated key', () => {
  const adapter = new SpyAdapter();
  const analytics = new AnalyticsProviderImpl(adapter, ['plan']);

  // id 'user-1' is identity, not gated; both bags carry only on-list keys → passes
  analytics.identify('user-1', { plan: 'pro' }, { plan: 'free' });
  expect(adapter.identified).toHaveLength(1);

  // off-list key in the FIRST bag (traits) is caught
  expect(() => analytics.identify('user-1', { role: 'admin' })).toThrow(/role/);
  // off-list key in the SECOND bag (traitsOnce) is caught
  expect(() => analytics.identify('user-1', { plan: 'pro' }, { firstSeen: 1 })).toThrow(
    /firstSeen/
  );
  expect(adapter.identified).toHaveLength(1);
});

test('an explicit empty allowlist activates the guard — every key throws', () => {
  const adapter = new SpyAdapter();
  const analytics = new AnalyticsProviderImpl(adapter, []);

  expect(() => analytics.track('e', { anyKey: 1 })).toThrow(/anyKey/);
  expect(adapter.captured).toHaveLength(0);
});

test('an undefined allowlist leaves the guard inactive — all keys pass', () => {
  const adapter = new SpyAdapter();
  const analytics = new AnalyticsProviderImpl(adapter);

  analytics.track('e', { anyKey: 1, another: 2 });

  expect(adapter.captured).toHaveLength(1);
  expect(adapter.captured[0].properties).toEqual({ anyKey: 1, another: 2 });
});

test('the guard fires even after optOut — a violation surfaces loudly while opted out', () => {
  const adapter = new SpyAdapter();
  const analytics = new AnalyticsProviderImpl(adapter, ['plan']);

  analytics.optOut();

  expect(() => analytics.track('e', { secret: 1 })).toThrow(/secret/);
  // an on-list event while opted out is silently swallowed by the no-op — no throw, no capture
  expect(() => analytics.track('e', { plan: 'pro' })).not.toThrow();
  expect(adapter.captured).toHaveLength(0);
});

test('createAnalytics threads allowlist into the facade — off-list throws, on-list passes', () => {
  const adapter = new SpyAdapter();
  const analytics = createAnalytics({ allowlist: ['plan'] }, adapter);

  analytics.track('signed_up', { plan: 'pro' });
  expect(adapter.captured).toHaveLength(1);

  expect(() => analytics.track('signed_up', { secret: 1 })).toThrow(/secret/);
});

test('createAnalytics threads onViolation drop-and-error-log', () => {
  const errorSpy = spyConsoleError();
  const adapter = new SpyAdapter();
  const analytics = createAnalytics(
    { allowlist: ['plan'], onViolation: 'drop-and-error-log' },
    adapter
  );

  expect(() => analytics.track('signed_up', { secret: 1 })).not.toThrow();

  expect(adapter.captured).toHaveLength(0);
  expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('secret'));
});

test('createAnalytics with no allowlist leaves the guard inactive (E2 backward-compat)', () => {
  const adapter = new SpyAdapter();
  const analytics = createAnalytics({}, adapter);

  analytics.track('x', { anything: 1 });
  analytics.identify('user-1', { plan: 'pro' });
  analytics.group('company', 'acme', { seats: 10 });

  expect(adapter.captured).toHaveLength(1);
  expect(adapter.identified).toHaveLength(1);
  expect(adapter.grouped).toHaveLength(1);
});
