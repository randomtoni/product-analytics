import type { AnalyticsAdapter } from './adapter';
import {
  AnalyticsProviderImpl,
  type RootAnalytics,
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

// A named per-context capture profile (E6-S8): a partial bundle of ALREADY-SHIPPED
// R1 toggles, each optional and falling back to the top-level config default. A profile
// SELECTS among existing toggles — it adds no new mechanism. `enrichment` (page/device/
// referrer/utm/country) varies live per event through a scoped `context()` view; the
// construction-time `autocapture` (and `enrichment.pageleave`) resolve once from the
// default context at construction (per-context construction-time toggles are a later
// additive slice).
export interface CaptureProfile {
  autocapture?: boolean;
  enrichment?: EnrichmentConfig;
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
  // Named per-context capture profiles (E6-S8). Each profile is a partial bundle of the
  // top-level toggles; `analytics.context(name)` returns a scoped view applying that
  // profile while sharing identity/session/transport with the root — config only (bar B).
  contexts?: Record<string, CaptureProfile>;
  // The context whose construction-time toggles (autocapture / pageleave) seed the shared
  // adapter at init. Per-event enrichment still varies per context via the scoped view.
  defaultContext?: string;
}

interface AnalyticsDeps {
  generateUuid?: () => string;
}

export function createAnalytics<const T extends TaxonomyDecl>(
  config: AnalyticsConfig & { taxonomy: Taxonomy<T> },
  adapter?: AnalyticsAdapter,
  deps?: AnalyticsDeps
): RootAnalytics<ShapeOf<T>>;
export function createAnalytics(
  config: AnalyticsConfig,
  adapter?: AnalyticsAdapter,
  deps?: AnalyticsDeps
): RootAnalytics;
export function createAnalytics(
  config: AnalyticsConfig,
  adapter?: AnalyticsAdapter,
  deps?: AnalyticsDeps
): RootAnalytics {
  const resolvedAdapter = adapter ?? new NoopAdapter();
  return new AnalyticsProviderImpl(
    resolvedAdapter,
    config.allowlist,
    config.onViolation,
    deps?.generateUuid,
    config.consentDefault,
    config.contexts
  );
}
