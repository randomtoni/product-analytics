import type { AnalyticsAdapter } from './adapter';
import {
  AnalyticsProviderImpl,
  type AnalyticsProvider,
  type ViolationPolicy,
} from './analytics-provider';
import { NoopAdapter } from './noop-adapter';
import type { ShapeOf, Taxonomy, TaxonomyDecl } from './taxonomy';

export interface CountryEnrichmentConfig {
  // A consumer-injected source of the country value — a plain value or a synchronous
  // provider (e.g. reading an edge header the consumer has surfaced). Consumer-supplied,
  // so its resolved VALUE crosses the E3 allowlist via the facade register({ country }).
  countrySource?: string | (() => string | undefined);
  // Signal the backend to skip its server-side GeoIP. A library-set toggle (not a consumer
  // value) → it does NOT cross the allowlist; it sets the adapter-internal wire flag only.
  disableGeoip?: boolean;
}

export interface EnrichmentConfig {
  page?: boolean;
  device?: boolean;
  referrer?: boolean;
  utm?: boolean;
  pageleave?: boolean;
  country?: CountryEnrichmentConfig;
}

export interface AnalyticsConfig {
  key?: string;
  taxonomy?: Taxonomy<TaxonomyDecl>;
  allowlist?: string[];
  onViolation?: ViolationPolicy;
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
  enrichment?: EnrichmentConfig;
  // Opt into minimal DOM autocapture (click/change/submit → element metadata). Default
  // OFF: unset/false binds ZERO DOM listeners. A capture MECHANISM, so a plain top-level
  // boolean sibling of `enrichment`, NOT a member of the enrichment opt-out object. On/off
  // is purely local — the library never phones home for autocapture gating.
  autocapture?: boolean;
}

interface AnalyticsDeps {
  generateUuid?: () => string;
}

export function createAnalytics<const T extends TaxonomyDecl>(
  config: AnalyticsConfig & { taxonomy: Taxonomy<T> },
  adapter?: AnalyticsAdapter,
  deps?: AnalyticsDeps
): AnalyticsProvider<ShapeOf<T>>;
export function createAnalytics(
  config: AnalyticsConfig,
  adapter?: AnalyticsAdapter,
  deps?: AnalyticsDeps
): AnalyticsProvider;
export function createAnalytics(
  config: AnalyticsConfig,
  adapter?: AnalyticsAdapter,
  deps?: AnalyticsDeps
): AnalyticsProvider {
  const resolvedAdapter = adapter ?? new NoopAdapter();
  return new AnalyticsProviderImpl(
    resolvedAdapter,
    config.allowlist,
    config.onViolation,
    deps?.generateUuid,
    config.consentDefault
  );
}
