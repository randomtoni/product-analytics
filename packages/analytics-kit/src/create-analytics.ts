import type { AnalyticsAdapter } from './adapter';
import { AnalyticsProviderImpl, type AnalyticsProvider } from './analytics-provider';
import { NoopAdapter } from './noop-adapter';
import type { ShapeOf, Taxonomy, TaxonomyDecl } from './taxonomy';

export interface AnalyticsConfig {
  key?: string;
  taxonomy?: Taxonomy<TaxonomyDecl>;
  allowlist?: string[];
  onViolation?: 'throw' | 'drop-and-error-log';
}

export function createAnalytics<const T extends TaxonomyDecl>(
  config: AnalyticsConfig & { taxonomy: Taxonomy<T> },
  adapter?: AnalyticsAdapter
): AnalyticsProvider<ShapeOf<T>>;
export function createAnalytics(
  config: AnalyticsConfig,
  adapter?: AnalyticsAdapter
): AnalyticsProvider;
export function createAnalytics(
  config: AnalyticsConfig,
  adapter?: AnalyticsAdapter
): AnalyticsProvider {
  const resolvedAdapter = adapter ?? new NoopAdapter();
  return new AnalyticsProviderImpl(resolvedAdapter, config.allowlist, config.onViolation);
}
