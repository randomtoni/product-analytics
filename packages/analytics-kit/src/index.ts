export const version = '0.0.0';

export type { NeutralEvent, NeutralProperties, NeutralTraits } from './neutral-event';
export type { AnalyticsAdapter, NeutralFetchOptions, NeutralFetchResponse } from './adapter';
export type { AnalyticsProvider } from './analytics-provider';
export { NoopAdapter } from './noop-adapter';
export { createAnalytics } from './create-analytics';
export type { AnalyticsConfig } from './create-analytics';
