import { createAnalytics, NoopAdapter } from 'analytics-kit';
import type {
  AnalyticsConfig,
  RootAnalytics,
  ShapeOf,
  Taxonomy,
  TaxonomyDecl,
} from 'analytics-kit';
import { RecordingAdapter } from './recording-adapter';
import { fernlyTaxonomy } from './taxonomy';

export interface FernlyHarness<T extends TaxonomyDecl> {
  analytics: RootAnalytics<ShapeOf<T>>;
  recorder: RecordingAdapter;
}

export function createFernlyAnalytics<T extends TaxonomyDecl>(
  config: AnalyticsConfig & { taxonomy: Taxonomy<T> }
): FernlyHarness<T>;
export function createFernlyAnalytics(
  config?: AnalyticsConfig
): FernlyHarness<(typeof fernlyTaxonomy)['decl']>;
export function createFernlyAnalytics(
  config: AnalyticsConfig = {}
): FernlyHarness<TaxonomyDecl> {
  const recorder = new RecordingAdapter();
  const adapter = config.key === undefined ? new NoopAdapter() : recorder;
  const resolvedConfig = { ...config, taxonomy: config.taxonomy ?? fernlyTaxonomy };
  const analytics = createAnalytics(resolvedConfig, adapter, {
    generateUuid: () => crypto.randomUUID(),
  });
  return { analytics, recorder };
}
