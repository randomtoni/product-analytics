import {
  createAnalytics as createSeamAnalytics,
  NoopAdapter,
  type AnalyticsAdapter,
  type AnalyticsConfig,
  type AnalyticsProvider,
  type ShapeOf,
  type Taxonomy,
  type TaxonomyDecl,
} from 'analytics-kit';
import { BrowserAdapter } from './browser-adapter';

export function cryptoRandomId(): string {
  return crypto.randomUUID();
}

export function resolveAdapter(config: AnalyticsConfig): AnalyticsAdapter {
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
        enrichment: config.enrichment,
        disableGeoip: config.enrichment?.country?.disableGeoip,
      });
}

// Resolve the consumer-injected country source once at init: a plain value is used as-is,
// a synchronous provider is called. Returns undefined when the source is absent or yields
// nothing — the caller then registers no `country` key.
function resolveCountry(config: AnalyticsConfig): string | undefined {
  const source = config.enrichment?.country?.countrySource;
  return typeof source === 'function' ? source() : source;
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

export function createAnalytics<const T extends TaxonomyDecl>(
  config: AnalyticsConfig & { taxonomy: Taxonomy<T> }
): AnalyticsProvider<ShapeOf<T>>;
export function createAnalytics(config: AnalyticsConfig): AnalyticsProvider;
export function createAnalytics(config: AnalyticsConfig): AnalyticsProvider {
  const analytics = createSeamAnalytics(config, resolveAdapter(config), {
    generateUuid: cryptoRandomId,
  });
  registerCountry(analytics, config);
  return analytics;
}
