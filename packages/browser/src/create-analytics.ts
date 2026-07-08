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
      });
}

export function createAnalytics<const T extends TaxonomyDecl>(
  config: AnalyticsConfig & { taxonomy: Taxonomy<T> }
): AnalyticsProvider<ShapeOf<T>>;
export function createAnalytics(config: AnalyticsConfig): AnalyticsProvider;
export function createAnalytics(config: AnalyticsConfig): AnalyticsProvider {
  return createSeamAnalytics(config, resolveAdapter(config), { generateUuid: cryptoRandomId });
}
