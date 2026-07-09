import type { DefaultTaxonomyShape, ShapeOf, Taxonomy, TaxonomyDecl } from 'analytics-kit';
import type { QueryClientConfig } from './config';
import type { AnalyticsQueryClient } from './query-client';
import { QueryNoop } from './query-noop';

export function createQueryClient<const T extends TaxonomyDecl>(
  config: QueryClientConfig & { taxonomy: Taxonomy<T> }
): AnalyticsQueryClient<ShapeOf<T>>;
export function createQueryClient(
  config: QueryClientConfig
): AnalyticsQueryClient<DefaultTaxonomyShape>;
export function createQueryClient(
  config: QueryClientConfig
): AnalyticsQueryClient<DefaultTaxonomyShape> {
  // Unkeyed ⇒ a silent no-op read client: the null object queries nothing, never
  // constructs an adapter or touches the network, and every method resolves to a
  // well-formed empty QueryResult (bar B — config-only adoption, an unconfigured
  // environment queries nothing). The personal key is DISTINCT from the ingest write
  // key and is read only here, server-side.
  if (config.personalKey === undefined) {
    return new QueryNoop<DefaultTaxonomyShape>();
  }
  if (config.queryEndpoint === undefined) {
    console.warn(
      'analytics: a personalKey is set but no queryEndpoint is configured; a query has nowhere to go. Returning a no-op query client. Set queryEndpoint.'
    );
    return new QueryNoop<DefaultTaxonomyShape>();
  }
  // Keyed + endpointed ⇒ the real HTTP query adapter. E8-S3 fills this seat in — it reads
  // `queryEndpoint`/`personalKey`/`projectId`/`fetch` off `config` and returns an
  // `AnalyticsQueryClient`. Until then the keyed path returns the same no-op so the
  // factory shape is stable and S3 is a fill-in, not a reshape.
  return new QueryNoop<DefaultTaxonomyShape>();
}
