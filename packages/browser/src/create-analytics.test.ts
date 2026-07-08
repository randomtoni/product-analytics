import { afterEach, describe, expect, test, vi } from 'vitest';
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

// --- E6-S6: pluggable country source (via the facade register() gate) ---
describe('pluggable country source — routed through the facade register() gate (E6-S6)', () => {
  let keySeq = 0;
  function freshKey(): string {
    keySeq += 1;
    return `country-key-${keySeq}-${Math.random().toString(36).slice(2)}`;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('a countrySource VALUE is delivered via facade register({ country }) — routed through the gate, not stamped in the adapter', () => {
    const registerSpy = vi.spyOn(BrowserAdapter.prototype, 'register');

    createAnalytics({
      key: freshKey(),
      allowlist: ['country'],
      consentDefault: 'granted',
      enrichment: { country: { countrySource: 'US' } },
    });

    // The adapter is NOT handed `country` directly — the facade register() is the path.
    expect(registerSpy).toHaveBeenCalledWith({ country: 'US' }, undefined);
  });

  test('a synchronous countrySource PROVIDER is called once at init and its yield is registered', () => {
    const registerSpy = vi.spyOn(BrowserAdapter.prototype, 'register');
    const provider = vi.fn((): string | undefined => 'DE');

    createAnalytics({
      key: freshKey(),
      allowlist: ['country'],
      consentDefault: 'granted',
      enrichment: { country: { countrySource: provider } },
    });

    expect(provider).toHaveBeenCalledTimes(1);
    expect(registerSpy).toHaveBeenCalledWith({ country: 'DE' }, undefined);
  });

  test('the injected country appears as a neutral super-prop DEFAULT on captured events', () => {
    // Capture the SAME adapter instance the facade wrapped (register() ran on it); a
    // fresh adapter would not see the memory-held super-prop (durable consent still pending).
    const registerSpy = vi.spyOn(BrowserAdapter.prototype, 'register');
    createAnalytics({
      key: freshKey(),
      allowlist: ['country'],
      consentDefault: 'granted',
      enrichment: { country: { countrySource: 'FR' } },
    });

    const adapter = registerSpy.mock.instances[0] as unknown as BrowserAdapter;
    const props = adapter.runCapturePipeline({
      event: 'x',
      distinctId: 'anonymous',
      dedupeId: 'd',
      timestamp: new Date(),
    }).properties as Record<string, unknown>;

    expect(props.country).toBe('FR');
  });

  test('a per-call track prop `country` WINS over the injected super-prop default', () => {
    const registerSpy = vi.spyOn(BrowserAdapter.prototype, 'register');
    createAnalytics({
      key: freshKey(),
      allowlist: ['country'],
      consentDefault: 'granted',
      enrichment: { country: { countrySource: 'FR' } },
    });

    const adapter = registerSpy.mock.instances[0] as unknown as BrowserAdapter;
    const props = adapter.runCapturePipeline({
      event: 'x',
      distinctId: 'anonymous',
      dedupeId: 'd',
      timestamp: new Date(),
      properties: { country: 'JP' },
    }).properties as Record<string, unknown>;

    expect(props.country).toBe('JP');
  });

  test('a countrySource that yields nothing (undefined) does NOT register and emits no country key', () => {
    const registerSpy = vi.spyOn(BrowserAdapter.prototype, 'register');

    const key = freshKey();
    createAnalytics({
      key,
      allowlist: ['country'],
      consentDefault: 'granted',
      enrichment: { country: { countrySource: (): string | undefined => undefined } },
    });

    expect(registerSpy).not.toHaveBeenCalled();

    const adapter = resolveAdapter({ key }) as BrowserAdapter;
    const props = adapter.runCapturePipeline({
      event: 'x',
      distinctId: 'anonymous',
      dedupeId: 'd',
      timestamp: new Date(),
    }).properties as Record<string, unknown>;

    expect(props).not.toHaveProperty('country');
  });

  test('an absent countrySource (no country slot) does NOT register', () => {
    const registerSpy = vi.spyOn(BrowserAdapter.prototype, 'register');

    createAnalytics({
      key: freshKey(),
      consentDefault: 'granted',
      enrichment: { page: false },
    });

    expect(registerSpy).not.toHaveBeenCalled();
  });

  // --- E3 gate: the injected country VALUE is consumer-supplied ⇒ allowlist-gated ---

  test('an off-list `country` value is REJECTED loudly (throw) under a restrictive allowlist WITHOUT country', () => {
    // The allowlist omits `country`; onViolation defaults to 'throw'. The register() gate
    // fires exactly as it would for an off-list consumer track prop.
    expect(() =>
      createAnalytics({
        key: freshKey(),
        allowlist: ['plan'],
        consentDefault: 'granted',
        enrichment: { country: { countrySource: 'US' } },
      })
    ).toThrow(/country.*allowlist/);
  });

  test("an off-list `country` value is DROPPED (no register) under onViolation 'drop-and-error-log'", () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const key = freshKey();

    createAnalytics({
      key,
      allowlist: ['plan'],
      onViolation: 'drop-and-error-log',
      consentDefault: 'granted',
      enrichment: { country: { countrySource: 'US' } },
    });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('country'));

    // Dropped at the gate ⇒ never stored ⇒ never merged onto an event.
    const adapter = resolveAdapter({ key }) as BrowserAdapter;
    const props = adapter.runCapturePipeline({
      event: 'x',
      distinctId: 'anonymous',
      dedupeId: 'd',
      timestamp: new Date(),
    }).properties as Record<string, unknown>;
    expect(props).not.toHaveProperty('country');
  });

  test('with NO allowlist configured, the injected country registers freely (ungated posture)', () => {
    const registerSpy = vi.spyOn(BrowserAdapter.prototype, 'register');

    createAnalytics({
      key: freshKey(),
      consentDefault: 'granted',
      enrichment: { country: { countrySource: 'US' } },
    });

    expect(registerSpy).toHaveBeenCalledWith({ country: 'US' }, undefined);
  });
});

// --- E6-S6: disableGeoip threads to the adapter as a [WIRE] toggle (NOT gated) ---
describe('disableGeoip threads through resolveAdapter → BrowserAdapterOptions (E6-S6)', () => {
  test('enrichment.country.disableGeoip threads to a resolved BrowserAdapter (config only, bar B)', () => {
    const adapter = resolveAdapter({
      key: 'geoip-key',
      enrichment: { country: { disableGeoip: true } },
    }) as BrowserAdapter;

    // The library-set flag drives the [WIRE] $geoip_disable stamp on the mapped wire event —
    // it does NOT cross the allowlist (no register()), unlike the country value.
    const wire = adapter.toWireEvent({
      event: 'x',
      distinctId: 'anonymous',
      dedupeId: 'd',
      timestamp: new Date(),
    }) as unknown as Record<string, unknown>;
    const props = wire.properties as Record<string, unknown>;

    expect(props['$geoip_disable']).toBe(true);
  });

  test('disableGeoip absent ⇒ no $geoip_disable on the wire (off by default)', () => {
    const adapter = resolveAdapter({ key: 'geoip-off-key' }) as BrowserAdapter;

    const wire = adapter.toWireEvent({
      event: 'x',
      distinctId: 'anonymous',
      dedupeId: 'd',
      timestamp: new Date(),
      properties: { plan: 'pro' },
    }) as unknown as Record<string, unknown>;
    const props = (wire.properties ?? {}) as Record<string, unknown>;

    expect(props).not.toHaveProperty('$geoip_disable');
  });
});
