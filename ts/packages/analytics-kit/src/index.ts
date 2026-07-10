export const version = '0.0.0';

export type {
  NeutralEvent,
  NeutralProperties,
  NeutralTraits,
  EnrichmentProfile,
} from './neutral-event';
export type { QueryColumn, QueryResult } from './query-result';
export type {
  AnalyticsAdapter,
  ConsentState,
  NeutralFetchOptions,
  NeutralFetchResponse,
  RegisterOptions,
  ResetOptions,
} from './adapter';
export type {
  AnalyticsProvider,
  RootAnalytics,
  ScopedAnalytics,
  ViolationPolicy,
} from './analytics-provider';
export type {
  FeatureFlagPort,
  SessionReplayPort,
  FlagSet,
  FlagContext,
  FlagEvaluateOptions,
  FlagValue,
  FlagReason,
} from './ports';
export { emptyFlagSet } from './ports';
export { buildFlagSet, seedBootstrap } from './flag-snapshot';
export type { FlagSnapshot } from './flag-snapshot';
export { NoopAdapter } from './noop-adapter';
export { createAnalytics } from './create-analytics';
export type {
  AnalyticsConfig,
  CountryEnrichmentConfig,
  EnrichmentConfig,
  CaptureProfile,
  FlagsConfig,
  SessionReplayConfig,
} from './create-analytics';
export { defineTaxonomy, RESERVED_PAGE_EVENT, RESERVED_PAGELEAVE_EVENT } from './taxonomy';
export { resolveOptedOut } from './consent-policy';
export { deriveAllowlistFromTaxonomy, enforceAllowlist } from './allowlist';
export type {
  Taxonomy,
  TaxonomyDecl,
  PropType,
  PropDecl,
  FlagDecl,
  FlagShape,
  ShapeOf,
  TaxonomyShape,
  DefaultTaxonomyShape,
  PropsParam,
} from './taxonomy';
