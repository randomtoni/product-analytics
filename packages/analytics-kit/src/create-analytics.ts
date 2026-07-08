import type { AnalyticsAdapter } from './adapter';
import { AnalyticsProviderImpl, type AnalyticsProvider } from './analytics-provider';
import { NoopAdapter } from './noop-adapter';

export interface AnalyticsConfig {
  key?: string;
}

export function createAnalytics(
  config: AnalyticsConfig,
  adapter?: AnalyticsAdapter
): AnalyticsProvider {
  const resolvedAdapter = adapter ?? new NoopAdapter();
  return new AnalyticsProviderImpl(resolvedAdapter);
}
