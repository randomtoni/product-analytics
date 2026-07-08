import { expect, expectTypeOf, test } from 'vitest';
import type {
  AnalyticsAdapter,
  ConsentState,
  NeutralFetchOptions,
  NeutralFetchResponse,
} from './adapter';
import type { NeutralEvent, NeutralTraits } from './neutral-event';

class RecordingAdapter implements AnalyticsAdapter {
  captured: NeutralEvent[] = [];
  identified: Array<{ distinctId: string; traits?: NeutralTraits; traitsOnce?: NeutralTraits }> = [];
  grouped: Array<{ type: string; key: string; traits?: NeutralTraits }> = [];
  aliased: Array<{ previousId: string; distinctId: string }> = [];
  flushed = 0;
  didShutdown = false;
  store = new Map<string, unknown>();
  consentState: ConsentState = 'granted';

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
    return this.consentState;
  }
  setConsentState(state: ConsentState): void {
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

test('a mock backend structurally satisfies AnalyticsAdapter and records the neutral verbs', () => {
  const adapter: AnalyticsAdapter = new RecordingAdapter();
  const recorder = adapter as RecordingAdapter;

  const event: NeutralEvent = {
    event: 'signed_up',
    distinctId: 'user-1',
    dedupeId: 'evt-1',
    properties: { plan: 'pro' },
  };
  adapter.capture(event);
  adapter.identify('user-1', { plan: 'pro' }, { firstSeen: 1 });
  adapter.group('company', 'acme', { seats: 10 });
  adapter.alias('anon-1', 'user-1');

  expect(recorder.captured).toEqual([event]);
  expect(recorder.identified).toEqual([
    { distinctId: 'user-1', traits: { plan: 'pro' }, traitsOnce: { firstSeen: 1 } },
  ]);
  expect(recorder.grouped).toEqual([{ type: 'company', key: 'acme', traits: { seats: 10 } }]);
  expect(recorder.aliased).toEqual([{ previousId: 'anon-1', distinctId: 'user-1' }]);
});

test('capture accepts a fully-resolved NeutralEvent with only its required fields', () => {
  const adapter: AnalyticsAdapter = new RecordingAdapter();
  const minimal: NeutralEvent = { event: 'pageview', distinctId: 'u', dedupeId: 'd' };

  adapter.capture(minimal);

  expect((adapter as RecordingAdapter).captured[0]).toBe(minimal);
});

test('identify and group carry no traits when omitted', () => {
  const recorder = new RecordingAdapter();

  recorder.identify('user-1');
  recorder.group('company', 'acme');

  expect(recorder.identified[0]).toEqual({
    distinctId: 'user-1',
    traits: undefined,
    traitsOnce: undefined,
  });
  expect(recorder.grouped[0]).toEqual({ type: 'company', key: 'acme', traits: undefined });
});

test('flush and shutdown resolve to void', async () => {
  const recorder = new RecordingAdapter();

  await expect(recorder.flush()).resolves.toBeUndefined();
  await expect(recorder.shutdown()).resolves.toBeUndefined();
  expect(recorder.flushed).toBe(1);
  expect(recorder.didShutdown).toBe(true);
});

test('fetch returns a neutral response whose json/text resolve and status is a number', async () => {
  const adapter: AnalyticsAdapter = new RecordingAdapter();

  const res = await adapter.fetch('https://ingest.example/capture', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'x' }),
  });

  expect(res.status).toBe(200);
  await expect(res.text()).resolves.toBe('POST https://ingest.example/capture');
  await expect(res.json()).resolves.toEqual({ ok: true });
});

test('persisted-property storage round-trips and null clears', () => {
  const recorder = new RecordingAdapter();

  recorder.setPersistedProperty('distinct_id', 'user-1');
  expect(recorder.getPersistedProperty<string>('distinct_id')).toBe('user-1');

  recorder.setPersistedProperty<string>('distinct_id', null);
  expect(recorder.getPersistedProperty<string>('distinct_id')).toBeUndefined();
});

test('client-identity primitives report id/version and an optional user-agent', () => {
  const recorder = new RecordingAdapter();

  expect(recorder.getLibraryId()).toBe('analytics-kit');
  expect(recorder.getLibraryVersion()).toBe('0.0.0');
  expect(recorder.getCustomUserAgent()).toBeUndefined();
});

test('the consent SPI pair round-trips a neutral tri-state and never surfaces a numeric encoding', () => {
  const recorder = new RecordingAdapter();

  const state: ConsentState = recorder.getConsentState();
  expect(['granted', 'denied', 'pending']).toContain(state);

  // set is void — the durable write is a side effect, not a returned value.
  expect(recorder.setConsentState('denied')).toBeUndefined();
  expect(recorder.getConsentState()).toBe('denied');
  recorder.setConsentState('pending');
  expect(recorder.getConsentState()).toBe('pending');
});

test('SPI signatures are pinned to the neutral types (compile-time)', () => {
  expectTypeOf<AnalyticsAdapter['capture']>().parameters.toEqualTypeOf<[NeutralEvent]>();
  expectTypeOf<AnalyticsAdapter['capture']>().returns.toEqualTypeOf<void>();
  expectTypeOf<AnalyticsAdapter['identify']>().returns.toEqualTypeOf<void>();
  expectTypeOf<AnalyticsAdapter['group']>().returns.toEqualTypeOf<void>();
  expectTypeOf<AnalyticsAdapter['alias']>().returns.toEqualTypeOf<void>();
  expectTypeOf<AnalyticsAdapter['flush']>().returns.toEqualTypeOf<Promise<void>>();
  expectTypeOf<AnalyticsAdapter['shutdown']>().returns.toEqualTypeOf<Promise<void>>();
  expectTypeOf<AnalyticsAdapter['getConsentState']>().returns.toEqualTypeOf<ConsentState>();
  expectTypeOf<ConsentState>().toEqualTypeOf<'granted' | 'denied' | 'pending'>();
  expectTypeOf<AnalyticsAdapter['setConsentState']>().parameters.toEqualTypeOf<[ConsentState]>();
  expectTypeOf<AnalyticsAdapter['setConsentState']>().returns.toEqualTypeOf<void>();

  expectTypeOf<AnalyticsAdapter['fetch']>().returns.toEqualTypeOf<Promise<NeutralFetchResponse>>();
  expectTypeOf<NeutralFetchResponse['json']>().returns.toEqualTypeOf<Promise<unknown>>();
  expectTypeOf<NeutralFetchResponse['text']>().returns.toEqualTypeOf<Promise<string>>();
  expectTypeOf<NeutralFetchOptions['method']>().toEqualTypeOf<'GET' | 'POST' | 'PUT' | 'PATCH'>();
  expectTypeOf<NeutralFetchOptions['body']>().toEqualTypeOf<string | undefined>();

  expectTypeOf<AnalyticsAdapter['getCustomUserAgent']>().returns.toEqualTypeOf<string | undefined>();
});
