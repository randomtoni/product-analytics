import type { AnalyticsAdapter } from './adapter';
import {
  AnalyticsProviderImpl,
  type AnalyticsProvider,
  type ViolationPolicy,
} from './analytics-provider';
import { NoopAdapter } from './noop-adapter';
import type { ShapeOf, Taxonomy, TaxonomyDecl } from './taxonomy';

export interface AnalyticsConfig {
  key?: string;
  taxonomy?: Taxonomy<TaxonomyDecl>;
  allowlist?: string[];
  onViolation?: ViolationPolicy;
  persistence?: 'cookie' | 'localStorage+cookie' | 'memory';
  consentDefault?: 'granted' | 'denied';
  sessionIdleTimeoutMs?: number;
  sessionMaxLengthMs?: number;
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
