export const version = '0.0.0';

export type { NeutralEvent, NeutralProperties, NeutralTraits } from './neutral-event';
export type {
  AnalyticsAdapter,
  ConsentState,
  NeutralFetchOptions,
  NeutralFetchResponse,
  RegisterOptions,
  ResetOptions,
} from './adapter';
export type { AnalyticsProvider } from './analytics-provider';
export type { FeatureFlagPort, SessionReplayPort } from './ports';
export { NoopAdapter } from './noop-adapter';
export { createAnalytics } from './create-analytics';
export type { AnalyticsConfig } from './create-analytics';
export { defineTaxonomy, RESERVED_PAGE_EVENT } from './taxonomy';
export { deriveAllowlistFromTaxonomy } from './allowlist';
export type {
  Taxonomy,
  TaxonomyDecl,
  PropType,
  PropDecl,
  ShapeOf,
  TaxonomyShape,
  DefaultTaxonomyShape,
} from './taxonomy';
