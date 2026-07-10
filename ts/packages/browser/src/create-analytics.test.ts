import { afterEach, describe, expect, test, vi } from 'vitest';
import { NoopAdapter } from 'analytics-kit';
import { createAnalytics, cryptoRandomId, resolveAdapter } from './create-analytics';
import { BrowserAdapter } from './browser-adapter';
import { storeName } from './persistence-keys';

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

test("consentDefault 'granted' + pending: capture RUNS and DELIVERS, yet cookies stay suppressed until an explicit grant", () => {
  const key = 'consent-default-granted-key';
  // Spy the pipeline on the prototype so we catch the SAME adapter the facade wraps —
  // reaching it is the proof the consent gate no longer drops the event (the regression).
  const pipeline = vi.spyOn(BrowserAdapter.prototype, 'runCapturePipeline');
  const analytics = createAnalytics({ key, consentDefault: 'granted' });

  // consentDefault resolves the pending state so capture runs at the facade...
  expect(analytics.hasOptedOut()).toBe(false);
  expect(() => analytics.track('x')).not.toThrow();

  // ...and the event actually reaches the capture pipeline in the adapter — it is
  // DELIVERED, not silently dropped by a consent gate born 'pending'.
  expect(pipeline).toHaveBeenCalledTimes(1);
  expect(pipeline.mock.calls[0][0].event).toBe('x');

  // ...but the adapter's durable consent is still pending, so no cookies are written
  // (cookie persistence keys off RAW 'granted', not the capture-permission default).
  window.dispatchEvent(new Event('beforeunload'));
  expect(document.cookie).not.toContain(key);

  vi.restoreAllMocks();
});

test('pending WITHOUT consentDefault (the fail-safe default) DROPS capture — no delivery', () => {
  const key = 'consent-default-unset-key';
  const pipeline = vi.spyOn(BrowserAdapter.prototype, 'runCapturePipeline');
  const analytics = createAnalytics({ key });

  // No consent policy ⇒ opt-out-by-default at the facade AND a suppressed adapter gate.
  expect(analytics.hasOptedOut()).toBe(true);
  expect(() => analytics.track('x')).not.toThrow();

  // The pending adapter gate drops the event — it never reaches the pipeline.
  expect(pipeline).not.toHaveBeenCalled();

  vi.restoreAllMocks();
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

  test('a THROWING countrySource provider degrades gracefully — createAnalytics still constructs, no country registered', () => {
    const registerSpy = vi.spyOn(BrowserAdapter.prototype, 'register');

    const key = freshKey();
    const thrower = (): string => {
      throw new Error('edge header read failed');
    };

    let analytics: ReturnType<typeof createAnalytics> | undefined;
    expect(() => {
      analytics = createAnalytics({
        key,
        allowlist: ['country'],
        consentDefault: 'granted',
        enrichment: { country: { countrySource: thrower } },
      });
    }).not.toThrow();

    expect(analytics).toBeDefined();
    // The throw was swallowed as "yields nothing": no country register call, and a normal
    // capture carries no country key.
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

describe('per-context capture profiles — named contexts applied by config only (E6-S8)', () => {
  let keySeq = 0;
  function freshKey(): string {
    keySeq += 1;
    return `ctx-key-${keySeq}-${Math.random().toString(36).slice(2)}`;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    window.history.pushState({}, '', '/');
  });

  // Grab the events minted through the shared BrowserAdapter + the adapter instance itself,
  // so we can run a minted (profile-carrying) event through the SAME adapter's enrichment
  // pipeline and observe the per-context difference end to end.
  function withCaptureSpy(): {
    events: Array<Parameters<BrowserAdapter['capture']>[0]>;
    adapter: () => BrowserAdapter;
  } {
    const events: Array<Parameters<BrowserAdapter['capture']>[0]> = [];
    const spy = vi.spyOn(BrowserAdapter.prototype, 'capture').mockImplementation(function (
      this: BrowserAdapter,
      event
    ) {
      events.push(event);
    });
    return { events, adapter: () => spy.mock.instances[0] as unknown as BrowserAdapter };
  }

  test('a consumer defines two named contexts by config only; each scoped track applies its profile (bar B)', () => {
    const { events, adapter } = withCaptureSpy();
    const analytics = createAnalytics({
      key: freshKey(),
      consentDefault: 'granted',
      contexts: {
        marketing: { enrichment: { device: false } },
        app: { enrichment: { device: true } },
      },
    });

    analytics.context('marketing').track('viewed_ad');
    analytics.context('app').track('opened_app');

    // Run each minted (profile-carrying) event through the SAME shared adapter's pipeline.
    const live = adapter();
    const marketingProps = live.runCapturePipeline(events[0]).properties as Record<string, unknown>;
    const appProps = live.runCapturePipeline(events[1]).properties as Record<string, unknown>;

    // The marketing profile disabled device enrichment; the app profile left it on. Same
    // adapter, same session/transport — only the per-event enrichment differs by context.
    expect(marketingProps).not.toHaveProperty('device_type');
    expect(appProps).toHaveProperty('device_type');
  });

  test('switching context does NOT change identity/session — two contexts share ONE distinct id + session (cross-context stitching)', () => {
    const { events } = withCaptureSpy();
    const analytics = createAnalytics({
      key: freshKey(),
      consentDefault: 'granted',
      contexts: { marketing: { enrichment: { utm: false } }, app: {} },
    });

    analytics.context('marketing').track('viewed_ad');
    analytics.context('app').track('opened_app');
    analytics.track('root_event');

    // ONE distinct id across both scoped contexts AND the root — the pre-login funnel stitches.
    const ids = new Set(events.map((e) => e.distinctId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(V7);
  });

  test('the same distinct id + session id survive across contexts through the full pipeline (E6-S8)', () => {
    const { events, adapter } = withCaptureSpy();
    const analytics = createAnalytics({
      key: freshKey(),
      consentDefault: 'granted',
      contexts: { marketing: {}, app: {} },
    });

    analytics.context('marketing').track('a');
    analytics.context('app').track('b');

    const live = adapter();
    const first = live.runCapturePipeline(events[0]);
    const second = live.runCapturePipeline(events[1]);

    expect(first.distinctId).toBe(second.distinctId);
    // ONE session id spans both contexts — the shared SessionIdManager is not per-context.
    expect(first.sessionId).toMatch(V7);
    expect(second.sessionId).toBe(first.sessionId);
  });

  test('a context enrichment difference is observable: marketing disables page, app keeps it (E6-S8)', () => {
    const { events, adapter } = withCaptureSpy();
    window.history.pushState({}, '', '/landing');
    const analytics = createAnalytics({
      key: freshKey(),
      consentDefault: 'granted',
      contexts: { marketing: { enrichment: { page: false } }, app: {} },
    });

    analytics.context('marketing').track('viewed_ad');
    analytics.context('app').track('opened_app');

    const live = adapter();
    const marketingProps = live.runCapturePipeline(events[0]).properties as Record<string, unknown>;
    const appProps = live.runCapturePipeline(events[1]).properties as Record<string, unknown>;

    expect(marketingProps).not.toHaveProperty('current_url');
    expect(appProps).toHaveProperty('current_url');
  });

  test('a root track (no context) uses the top-level config enrichment, unaffected by any context profile (E6-S8)', () => {
    const { events, adapter } = withCaptureSpy();
    const analytics = createAnalytics({
      key: freshKey(),
      consentDefault: 'granted',
      // A context that would disable device — but a ROOT track must NOT pick it up.
      contexts: { marketing: { enrichment: { device: false } } },
    });

    analytics.track('root_event');

    const rootProps = adapter().runCapturePipeline(events[0]).properties as Record<string, unknown>;
    expect(rootProps).toHaveProperty('device_type');
    expect(events[0].enrichmentProfile).toBeUndefined();
  });

  test("defaultContext's construction-time autocapture toggle seeds the shared adapter (E6-S8)", () => {
    // autocapture is a construction-time DOM behavior — it resolves from defaultContext at
    // init. A defaultContext with autocapture:true binds listeners; one without does not.
    const on = resolveAdapter({
      key: freshKey(),
      contexts: { app: { autocapture: true } },
      defaultContext: 'app',
    }) as BrowserAdapter;
    const off = resolveAdapter({
      key: freshKey(),
      contexts: { app: { autocapture: false } },
      defaultContext: 'app',
    }) as BrowserAdapter;

    const detachOn = (on as unknown as { detachAutocaptureListeners?: () => void })
      .detachAutocaptureListeners;
    const detachOff = (off as unknown as { detachAutocaptureListeners?: () => void })
      .detachAutocaptureListeners;

    expect(typeof detachOn).toBe('function');
    expect(detachOff).toBeUndefined();
  });

  test('defaultContext autocapture falls back to the top-level config when the profile omits it (E6-S8)', () => {
    // The default context defines no autocapture ⇒ the top-level config.autocapture drives it.
    const adapter = resolveAdapter({
      key: freshKey(),
      autocapture: true,
      contexts: { app: { enrichment: { device: false } } },
      defaultContext: 'app',
    }) as BrowserAdapter;

    const detach = (adapter as unknown as { detachAutocaptureListeners?: () => void })
      .detachAutocaptureListeners;
    expect(typeof detach).toBe('function');
  });

  test("defaultContext's pageleave toggle seeds the shared adapter's construction-time pageleave (E6-S8)", () => {
    // pageleave is construction-time (one unload). A defaultContext disabling it must resolve
    // to a NON-pageleave-minting adapter even though the top-level config leaves it on.
    const adapter = resolveAdapter({
      key: freshKey(),
      contexts: { app: { enrichment: { pageleave: false } } },
      defaultContext: 'app',
    }) as BrowserAdapter;

    expect(
      (adapter as unknown as { capturePageleaveEnabled: boolean }).capturePageleaveEnabled
    ).toBe(false);
  });

  test('with no defaultContext, construction-time toggles fall through to the top-level config (zero change) (E6-S8)', () => {
    const adapter = resolveAdapter({
      key: freshKey(),
      autocapture: true,
      contexts: { marketing: { autocapture: false } },
    }) as BrowserAdapter;

    // marketing is not the defaultContext (none set) ⇒ its autocapture:false is NOT applied;
    // the top-level autocapture:true drives the construction-time binding.
    const detach = (adapter as unknown as { detachAutocaptureListeners?: () => void })
      .detachAutocaptureListeners;
    expect(typeof detach).toBe('function');
  });
});

// Generalizes to ANY consumer register() while opted-out, not just the config country prop:
// the facade routes register() to the LIVE adapter (like reset), so under pending the value
// lands in the memory-backed store — retained, never persisted/sent — and promoteToDurable
// flushes it durable on optIn(). Country is exercised alongside a bare consumer register().
describe('super-prop registered while opted-out survives opt-in + reload (defect #11)', () => {
  let keySeq = 0;
  function freshKey(): string {
    keySeq += 1;
    return `optout-register-${keySeq}-${Math.random().toString(36).slice(2)}`;
  }

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  // Read the super-props merged onto a captured event by running an event through the SAME
  // adapter's pipeline. Reserved/identity keys are excluded by mergeSuperProperties, so what
  // survives here are the consumer super-props (country, plan) stamped as event defaults.
  function eventProps(adapter: BrowserAdapter): Record<string, unknown> {
    return adapter.runCapturePipeline({
      event: 'probe',
      distinctId: adapter.getDistinctId(),
      dedupeId: 'd',
      timestamp: new Date(),
    }).properties as Record<string, unknown>;
  }

  test("country+plan-survive-opt-in→reload: pending register lands in MEMORY only, promotes durable on optIn, survives reload and stamps a captured event", () => {
    const key = freshKey();
    // consentDefault unset ⇒ pending resolves to opted-out (fail-safe). A config country
    // source AND a bare consumer register() both flow through the facade register() gate.
    const registerSpy = vi.spyOn(BrowserAdapter.prototype, 'register');
    const analytics = createAnalytics({
      key,
      allowlist: ['country', 'plan'],
      enrichment: { country: { countrySource: 'US' } },
    });
    expect(analytics.hasOptedOut()).toBe(true);
    analytics.register({ plan: 'pro' });

    // (a) WHILE PENDING — both reached the LIVE adapter's store (memory-backed): they are
    // present as super-props in memory but NOT written to the durable localStorage backend.
    const live = registerSpy.mock.instances[0] as unknown as BrowserAdapter;
    const memProps = eventProps(live);
    expect(memProps.country).toBe('US');
    expect(memProps.plan).toBe('pro');

    // The durable backend holds nothing yet — the pending client never persisted the props.
    const durableRaw = localStorage.getItem(storeName(key));
    if (durableRaw !== null) {
      const durable = JSON.parse(durableRaw) as Record<string, unknown>;
      expect(durable).not.toHaveProperty('country');
      expect(durable).not.toHaveProperty('plan');
    }

    // ...and a track while pending does NOT emit (capture gated at the facade AND the adapter).
    const pipeline = vi.spyOn(BrowserAdapter.prototype, 'runCapturePipeline');
    analytics.track('purchase');
    expect(pipeline).not.toHaveBeenCalled();
    pipeline.mockRestore();

    // (b) AFTER optIn — promoteToDurable flushes memory→durable synchronously, so the
    // durable backend now holds both super-props.
    analytics.optIn();
    const promotedRaw = localStorage.getItem(storeName(key));
    expect(promotedRaw).not.toBeNull();
    const promoted = JSON.parse(promotedRaw as string) as Record<string, unknown>;
    expect(promoted.country).toBe('US');
    expect(promoted.plan).toBe('pro');

    // ...and a SIMULATED RELOAD — a fresh client over the SAME durable backend — recovers
    // BOTH super-props and stamps them onto a captured event.
    const reloaded = resolveAdapter({
      key,
      allowlist: ['country', 'plan'],
    } as Parameters<typeof resolveAdapter>[0]) as BrowserAdapter;
    const reloadedProps = eventProps(reloaded);
    expect(reloadedProps.country).toBe('US');
    expect(reloadedProps.plan).toBe('pro');
  });

  test('allowlist-still-gates-on-pending: an off-list country register throws while opted-out (gate not bypassed by the live route)', () => {
    // Allowlist EXCLUDES country; onViolation defaults to throw. The register gate fires on
    // the pending path exactly as on the granted path — the live route does not bypass it.
    expect(() =>
      createAnalytics({
        key: freshKey(),
        allowlist: ['plan'],
        enrichment: { country: { countrySource: 'US' } },
      })
    ).toThrow(/country.*allowlist/);
  });

  test("allowlist-still-gates-on-pending (drop): an off-list pending register drops and never persists", () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const key = freshKey();

    createAnalytics({
      key,
      allowlist: ['plan'],
      onViolation: 'drop-and-error-log',
      enrichment: { country: { countrySource: 'US' } },
    });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('country'));
    // Dropped at the gate ⇒ never stored ⇒ not in memory nor durable.
    const adapter = resolveAdapter({ key } as Parameters<typeof resolveAdapter>[0]) as BrowserAdapter;
    expect(eventProps(adapter)).not.toHaveProperty('country');
  });

  test('denied-never-sent: a DENIED client register never writes durable, the transport spy sees nothing, and no super-prop survives reload', async () => {
    const key = freshKey();
    // A real POST/beacon must never carry the registered super-prop under denial. Spy the
    // wire transports so any send is observable. jsdom's navigator has no sendBeacon, so
    // define a spy-able stub before spying (the beacon path reads navigator.sendBeacon).
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', { status: 200 })
    );
    const beacon = vi.fn((): boolean => true);
    const priorBeacon = (navigator as unknown as { sendBeacon?: unknown }).sendBeacon;
    Object.defineProperty(navigator, 'sendBeacon', {
      value: beacon,
      configurable: true,
      writable: true,
    });

    // consentDefault unset (pending) then an explicit optOut → durable 'denied'.
    const analytics = createAnalytics({
      key,
      allowlist: ['plan'],
      ingestHost: 'https://ingest.example.com',
    });
    analytics.optOut();
    expect(analytics.hasOptedOut()).toBe(true);

    analytics.register({ plan: 'pro' });
    analytics.track('purchase');
    await analytics.flush();
    window.dispatchEvent(new Event('beforeunload'));

    // Retain-in-memory is fine; SENT or PERSISTED is the failure. Nothing on the wire.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();

    // The durable backend was never written while denied.
    const durableRaw = localStorage.getItem(storeName(key));
    if (durableRaw !== null) {
      const durable = JSON.parse(durableRaw) as Record<string, unknown>;
      expect(durable).not.toHaveProperty('plan');
    }

    // After a reload (fresh client over the same backend) the super-prop is NOT present —
    // it lived only in the prior client's memory and was never persisted.
    const reloaded = resolveAdapter({ key } as Parameters<typeof resolveAdapter>[0]) as BrowserAdapter;
    expect(eventProps(reloaded)).not.toHaveProperty('plan');

    if (priorBeacon === undefined) {
      delete (navigator as unknown as { sendBeacon?: unknown }).sendBeacon;
    } else {
      Object.defineProperty(navigator, 'sendBeacon', {
        value: priorBeacon,
        configurable: true,
        writable: true,
      });
    }
  });
});
