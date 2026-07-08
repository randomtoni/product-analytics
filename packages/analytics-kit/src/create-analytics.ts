import type { AnalyticsAdapter } from './adapter';
import { AnalyticsProviderImpl, type AnalyticsProvider } from './analytics-provider';
import { NoopAdapter } from './noop-adapter';

export interface AnalyticsConfig {
  key?: string;
}

export function createAnalytics(
  // Unused in the seam by design: the target entry (browser/node) reads config.key to pick its
  // adapter, and E3+ facade concerns (allowlist/taxonomy) will consume config here.
  config: AnalyticsConfig,
  adapter?: AnalyticsAdapter
): AnalyticsProvider {
  const resolvedAdapter = adapter ?? new NoopAdapter();
  return new AnalyticsProviderImpl(resolvedAdapter);
}
