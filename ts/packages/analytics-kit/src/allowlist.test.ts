import { afterEach, expect, test, vi } from 'vitest';
import type {
  AnalyticsAdapter,
  ConsentState,
  NeutralFetchOptions,
  NeutralFetchResponse,
  RegisterOptions,
} from './adapter';
import type { NeutralEvent, NeutralProperties, NeutralTraits } from './neutral-event';
import { createAnalytics } from './create-analytics';
import { defineTaxonomy } from './taxonomy';
import { deriveAllowlistFromTaxonomy, enforceAllowlist } from './allowlist';

function spyConsoleError() {
  const c = (globalThis as { console: { error: (...args: unknown[]) => void } }).console;
  return vi.spyOn(c, 'error').mockImplementation(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
});

test('enforceAllowlist is exported from the seam and callable standalone — no AnalyticsProviderImpl needed', () => {
  expect(enforceAllowlist).toBeTypeOf('function');
  expect(enforceAllowlist(new Set(['plan']), 'throw', { plan: 'pro' })).toBe(true);
});

test('enforceAllowlist: undefined allowlist ⇒ every key allowed, returns true (guard inactive)', () => {
  expect(enforceAllowlist(undefined, 'throw', { anyKey: 1, another: 2 })).toBe(true);
});

test('enforceAllowlist: throw policy raises the same Error message naming the off-list key', () => {
  expect(() => enforceAllowlist(new Set(['plan']), 'throw', { ssn: '123' })).toThrow(
    'analytics-kit: property "ssn" is not on the payload allowlist'
  );
});

test('enforceAllowlist: drop-and-error-log emits console.error and returns false (the drop signal), no throw', () => {
  const errorSpy = spyConsoleError();

  const result = enforceAllowlist(new Set(['plan']), 'drop-and-error-log', { ssn: '123' });

  expect(result).toBe(false);
  expect(errorSpy).toHaveBeenCalledTimes(1);
  expect(errorSpy).toHaveBeenCalledWith(
    'analytics-kit: property "ssn" is not on the payload allowlist'
  );
});

test('enforceAllowlist: all-on-list keys ⇒ returns true, no console.error', () => {
  const errorSpy = spyConsoleError();

  const result = enforceAllowlist(new Set(['plan', 'seats']), 'drop-and-error-log', {
    plan: 'pro',
    seats: 3,
  });

  expect(result).toBe(true);
  expect(errorSpy).not.toHaveBeenCalled();
});

test('enforceAllowlist: multi-bag varargs — an off-list key in the SECOND bag is caught (identify traits + traitsOnce)', () => {
  expect(() =>
    enforceAllowlist(new Set(['plan']), 'throw', { plan: 'pro' }, { firstSeen: 1 })
  ).toThrow(/firstSeen/);
});

test('enforceAllowlist: multi-bag short-circuits on the FIRST off-list key across bags', () => {
  const errorSpy = spyConsoleError();

  const result = enforceAllowlist(
    new Set(['plan']),
    'drop-and-error-log',
    { plan: 'pro', ssn: '123' },
    { plan: 'free' }
  );

  expect(result).toBe(false);
  // one violation only — the loop stops at the first off-list key
  expect(errorSpy).toHaveBeenCalledTimes(1);
  expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('ssn'));
});

test('enforceAllowlist: an undefined bag is skipped (not an off-list violation)', () => {
  expect(enforceAllowlist(new Set(['plan']), 'throw', undefined, { plan: 'pro' })).toBe(true);
  expect(enforceAllowlist(new Set(['plan']), 'throw', { plan: 'pro' }, undefined)).toBe(true);
});

test('enforceAllowlist: no bags at all ⇒ trivially allowed, returns true', () => {
  expect(enforceAllowlist(new Set(['plan']), 'throw')).toBe(true);
});

test('enforceAllowlist: an explicit empty allowlist activates the guard — every key fails', () => {
  expect(() => enforceAllowlist(new Set(), 'throw', { anyKey: 1 })).toThrow(/anyKey/);
});

test('enforceAllowlist inspects KEYS only — never values (value differences do not change the verdict)', () => {
  const allowlist = new Set(['plan']);
  // Same key, wildly different values — all pass, because only the key is checked.
  expect(enforceAllowlist(allowlist, 'throw', { plan: 'pro' })).toBe(true);
  expect(enforceAllowlist(allowlist, 'throw', { plan: undefined })).toBe(true);
  expect(enforceAllowlist(allowlist, 'throw', { plan: { nested: 'secret' } })).toBe(true);
  // And an off-list key fails regardless of its (harmless-looking) value.
  expect(() => enforceAllowlist(allowlist, 'throw', { ssn: null })).toThrow(/ssn/);
});

class SpyAdapter implements AnalyticsAdapter {
  captured: NeutralEvent[] = [];
  identified: Array<{ distinctId: string; traits?: NeutralTraits; traitsOnce?: NeutralTraits }> = [];
  grouped: Array<{ type: string; key: string; traits?: NeutralTraits }> = [];
  aliased: Array<{ previousId: string; distinctId: string }> = [];
  registered: Array<{ props: NeutralProperties; options?: RegisterOptions }> = [];
  unregistered: string[] = [];

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
  async flush(): Promise<void> {}
  async shutdown(): Promise<void> {}
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

// An adapter that stamps a library-computed enrichment key AFTER the facade guard has run —
// i.e. downstream of capture. Its key is deliberately NOT on any allowlist.
class EnrichingAdapter extends SpyAdapter {
  static readonly computedKey = 'lib_computed_at';

  capture(event: NeutralEvent): void {
    super.capture({
      ...event,
      properties: { ...event.properties, [EnrichingAdapter.computedKey]: 'downstream' },
    });
  }
}

// Simulates an E6-style consumer-config value producer that injects a value into the props bag
// BEFORE the facade call — the injected key therefore reaches the guard like any consumer key.
function injectConsumerValue(
  props: NeutralProperties,
  key: string,
  value: unknown
): NeutralProperties {
  return { ...props, [key]: value };
}

const fixtureTaxonomy = defineTaxonomy({
  events: {
    signed_up: { plan: 'string', seats: 'number' },
    checkout: { plan: 'string', total: 'number' }, // 'plan' repeats across events
    logged_out: {},
  },
  traits: { role: 'string', tenure: 'number' },
  groups: {
    workspace: { tier: 'string', seats: 'number' }, // 'seats' repeats a group vs. an event
    team: { size: 'number' },
  },
});

test('deriveAllowlistFromTaxonomy returns the deduped union of event-prop, trait, and group-prop keys', () => {
  const derived = deriveAllowlistFromTaxonomy(fixtureTaxonomy);

  expect(new Set(derived)).toEqual(
    new Set(['plan', 'seats', 'total', 'role', 'tenure', 'tier', 'size'])
  );
  // deduped: 'plan' (two events) and 'seats' (event + group) each appear once
  expect(derived).toHaveLength(new Set(derived).size);
  expect(derived.filter((k) => k === 'plan')).toHaveLength(1);
  expect(derived.filter((k) => k === 'seats')).toHaveLength(1);
});

test('no event NAMES leak into the derived allowlist — only event-prop keys', () => {
  const derived = deriveAllowlistFromTaxonomy(fixtureTaxonomy);

  for (const eventName of ['signed_up', 'checkout', 'logged_out']) {
    expect(derived).not.toContain(eventName);
  }
});

test('no group-TYPE names leak into the derived allowlist — only group-prop keys', () => {
  const derived = deriveAllowlistFromTaxonomy(fixtureTaxonomy);

  for (const groupType of ['workspace', 'team']) {
    expect(derived).not.toContain(groupType);
  }
});

test('composition is a consumer-side spread: taxonomy-derived key AND explicit super-prop both pass the guard', () => {
  const adapter = new SpyAdapter();
  const analytics = createAnalytics(
    { allowlist: [...deriveAllowlistFromTaxonomy(fixtureTaxonomy), 'app_version'] },
    adapter
  );

  // a taxonomy-derived key passes without the consumer restating it by hand
  analytics.track('signed_up', { plan: 'pro' });
  // a super-prop present ONLY in the explicit spread (in no event's taxonomy entry) also passes
  analytics.track('signed_up', { app_version: '1.2.3' });

  expect(adapter.captured).toHaveLength(2);
  expect(adapter.captured[0].properties).toEqual({ plan: 'pro' });
  expect(adapter.captured[1].properties).toEqual({ app_version: '1.2.3' });

  // and an off-list key is still rejected — the guard is genuinely active
  expect(() => analytics.track('signed_up', { secret: 1 })).toThrow(/secret/);
});

test('consumer-supplied value ⇒ gated: an injected off-list key is rejected by the guard', () => {
  const adapter = new SpyAdapter();
  const analytics = createAnalytics(
    { allowlist: deriveAllowlistFromTaxonomy(fixtureTaxonomy) },
    adapter
  );

  // 'country' is NOT on the allowlist; injecting it before the facade call is gated just like a
  // hand-typed prop — proving the seam E6's country source conforms to.
  expect(() =>
    analytics.track('signed_up', injectConsumerValue({ plan: 'pro' }, 'country', 'US'))
  ).toThrow(/country/);
  expect(adapter.captured).toHaveLength(0);
});

test('consumer-supplied value ⇒ gated: an injected on-list key passes when the consumer allowlists it', () => {
  const adapter = new SpyAdapter();
  const analytics = createAnalytics(
    { allowlist: [...deriveAllowlistFromTaxonomy(fixtureTaxonomy), 'country'] },
    adapter
  );

  analytics.track('signed_up', injectConsumerValue({ plan: 'pro' }, 'country', 'US'));

  expect(adapter.captured).toHaveLength(1);
  expect(adapter.captured[0].properties).toEqual({ plan: 'pro', country: 'US' });
});

test('library-computed ⇒ trusted: an enrichment key stamped downstream of the guard is never gated', () => {
  const adapter = new EnrichingAdapter();
  // allowlist admits only 'plan'; the adapter's computed key is deliberately off-list
  const analytics = createAnalytics({ allowlist: ['plan'] }, adapter);

  analytics.track('signed_up', { plan: 'pro' });

  expect(adapter.captured).toHaveLength(1);
  // the off-list library-computed key rode through untouched — it never reached the guard
  expect(adapter.captured[0].properties).toEqual({
    plan: 'pro',
    [EnrichingAdapter.computedKey]: 'downstream',
  });
});

test('empty-list edge: derive over events with no prop keys returns [] and that [] ACTIVATES the guard (allow-nothing)', () => {
  const emptyTaxonomy = defineTaxonomy({ events: { ping: {}, pong: {} } });

  const derived = deriveAllowlistFromTaxonomy(emptyTaxonomy);
  expect(derived).toEqual([]);

  const adapter = new SpyAdapter();
  // Spreading ONLY the empty derived list yields `allowlist: []`. Under S2's `allowlist !== undefined`
  // activation predicate, [] is ACTIVE (present-but-empty policy = allow nothing), NOT inactive —
  // so every consumer key throws. This is the intended [] ≠ undefined interaction.
  const analytics = createAnalytics({ allowlist: [...derived] }, adapter);

  expect(() => analytics.track('ping', { anything: 1 })).toThrow(/anything/);
  expect(adapter.captured).toHaveLength(0);
});

test('a taxonomy with only traits or only groups derives just those keys', () => {
  const traitsOnly = deriveAllowlistFromTaxonomy(
    defineTaxonomy({ events: { e: {} }, traits: { role: 'string' } })
  );
  expect(new Set(traitsOnly)).toEqual(new Set(['role']));

  const groupsOnly = deriveAllowlistFromTaxonomy(
    defineTaxonomy({ events: { e: {} }, groups: { workspace: { tier: 'string' } } })
  );
  expect(new Set(groupsOnly)).toEqual(new Set(['tier']));
});

test('derivation excludes decl.page prop keys — page props never enter the derived allowlist', () => {
  const derived = deriveAllowlistFromTaxonomy(
    defineTaxonomy({ events: { e: {} }, page: { url: 'string' } })
  );

  expect(derived).not.toContain('url');
  expect(derived).toEqual([]);
});

test('supplying a taxonomy does NOT auto-derive or activate the guard — a taxonomy is a typing decision, not a privacy decision', () => {
  const spy = new SpyAdapter();
  const analytics = createAnalytics({ taxonomy: fixtureTaxonomy }, spy);

  // off_taxonomy_key is typed OUT of signed_up (a typing decision, rejected at compile time). With
  // no allowlist supplied the runtime guard is inactive, so the key is NOT gated OUT (a separate
  // privacy decision) — it still reaches the adapter. Typing decision ≠ privacy decision.
  // @ts-expect-error off_taxonomy_key is not part of signed_up's declared props
  analytics.track('signed_up', { off_taxonomy_key: 1 });

  expect(spy.captured).toHaveLength(1);
  expect(spy.captured[0].properties).toEqual({ off_taxonomy_key: 1 });
});
