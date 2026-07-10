import {
  createAnalytics as createSeamAnalytics,
  NoopAdapter,
  type AnalyticsAdapter,
  type AnalyticsConfig,
  type AnalyticsProvider,
  type CaptureProfile,
  type RootAnalytics,
  type ShapeOf,
  type Taxonomy,
  type TaxonomyDecl,
} from 'analytics-kit';
import { BrowserAdapter } from './browser-adapter';
import { FlagClient } from './feature-flags';

export function cryptoRandomId(): string {
  return crypto.randomUUID();
}

// The default context's profile (E6-S8), if a defaultContext is named and defined. Its
// construction-time toggles (autocapture / pageleave) seed the ONE shared adapter at init —
// per-event enrichment still varies per context via the scoped view. Undefined ⇒ the
// top-level config drives the toggles exactly as before (zero change for a consumer with
// no contexts).
function defaultProfile(config: AnalyticsConfig): CaptureProfile | undefined {
  return config.defaultContext === undefined
    ? undefined
    : config.contexts?.[config.defaultContext];
}

export function resolveAdapter(config: AnalyticsConfig): AnalyticsAdapter {
  const profile = defaultProfile(config);
  // autocapture + pageleave are construction-time DOM behaviors (one listener set / one
  // unload) — they resolve from the default context, falling back to the top-level config.
  // Per-event enrichment (page/device/referrer/utm/geoip) stays seeded from the top-level
  // config for ROOT captures; a scoped context view overrides it live per event.
  const autocapture = profile?.autocapture ?? config.autocapture;
  const pageleave = profile?.enrichment?.pageleave ?? config.enrichment?.pageleave;
  // Fold the resolved construction-time pageleave back onto the enrichment object (its
  // authoritative channel at construction) without disturbing the live per-event toggles.
  const enrichment =
    config.enrichment === undefined && pageleave === undefined
      ? undefined
      : { ...config.enrichment, ...(pageleave === undefined ? {} : { pageleave }) };
  return config.key === undefined
    ? new NoopAdapter()
    : new BrowserAdapter({
        key: config.key,
        persistence: config.persistence,
        cookieDomain: config.cookieDomain,
        crossSubdomainCookie: config.crossSubdomainCookie,
        sessionIdleTimeoutMs: config.sessionIdleTimeoutMs,
        sessionMaxLengthMs: config.sessionMaxLengthMs,
        ingestHost: config.ingestHost,
        ingestPath: config.ingestPath,
        botFilter: config.botFilter,
        blockedUserAgents: config.blockedUserAgents,
        flushInterval: config.flushInterval,
        flushAt: config.flushAt,
        compression: config.compression,
        enrichment,
        disableGeoip: config.enrichment?.country?.disableGeoip,
        autocapture,
        consentDefault: config.consentDefault,
      });
}

// Resolve the consumer-injected country source once at init: a plain value is used as-is,
// a synchronous provider is called. Returns undefined when the source is absent or yields
// nothing — the caller then registers no `country` key.
function resolveCountry(config: AnalyticsConfig): string | undefined {
  const source = config.enrichment?.country?.countrySource;
  if (typeof source !== 'function') {
    return source;
  }
  // A consumer provider that throws must degrade gracefully — treat it as "yields nothing"
  // rather than aborting createAnalytics and leaving the app with no client at all.
  try {
    return source();
  } catch {
    return undefined;
  }
}

// The country VALUE is consumer-supplied, so it must cross the E3 allowlist. Route it
// through the facade register({ country }) — the same gate a consumer super-prop takes —
// rather than stamping it in the adapter. register() stores it as a super-prop that
// mergeSuperProperties then merges onto every event as a default (a per-call track prop
// of the same key wins). Nothing yielded ⇒ no register call ⇒ no country key.
function registerCountry(analytics: AnalyticsProvider, config: AnalyticsConfig): void {
  const country = resolveCountry(config);
  if (country !== undefined) {
    analytics.register({ country });
  }
}

// Attach the browser flag adapter to the provider's `flags` slot when the client is keyed —
// the only case a BrowserAdapter (with its identity + fetch SPIs) exists to source. An unkeyed
// client resolves the NoopAdapter, so the slot stays `undefined` (no flag machinery; the React
// binding then falls back to the seam's canonical empty snapshot). Config-only — no seam edit;
// the assignment fills an existing optional interface member, leaving the keyof pin untouched.
function attachFlags(analytics: AnalyticsProvider, adapter: AnalyticsAdapter, config: AnalyticsConfig): void {
  if (!(adapter instanceof BrowserAdapter)) {
    return;
  }
  analytics.flags = new FlagClient({
    key: config.key as string,
    ingestHost: config.ingestHost,
    bootstrap: config.flags?.bootstrap,
    getDistinctId: () => adapter.getDistinctId(),
    fetch: (url, options) => adapter.fetch(url, options),
  });
}

export function createAnalytics<const T extends TaxonomyDecl>(
  config: AnalyticsConfig & { taxonomy: Taxonomy<T> }
): RootAnalytics<ShapeOf<T>>;
export function createAnalytics(config: AnalyticsConfig): RootAnalytics;
export function createAnalytics(config: AnalyticsConfig): RootAnalytics {
  const adapter = resolveAdapter(config);
  const analytics = createSeamAnalytics(config, adapter, {
    generateUuid: cryptoRandomId,
  });
  registerCountry(analytics, config);
  attachFlags(analytics, adapter, config);
  return analytics;
}
