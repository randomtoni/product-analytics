import type { DefaultTaxonomyShape, ShapeOf, Taxonomy, TaxonomyDecl } from '@randomtoni/analytics-kit';
import type { QueryClientConfig } from './config';
import { createHttpQueryAdapterFromConfig } from './http-query-adapter';
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
  if (config.projectId === undefined || config.projectId === '') {
    console.warn(
      'analytics: a queryEndpoint is set but no projectId is configured; the query URL is malformed and will fail. Set projectId.'
    );
  }
  // Keyed + endpointed ⇒ the real HTTP query adapter. It reads
  // `queryEndpoint`/`personalKey`/`projectId`/`fetch` off `config` and translates each
  // neutral primitive into the adapter-internal wire, POSTs with Bearer personal-key auth,
  // and normalizes the response into a neutral `QueryResult`.
  return createHttpQueryAdapterFromConfig<DefaultTaxonomyShape>({
    queryEndpoint: config.queryEndpoint,
    personalKey: config.personalKey,
    projectId: config.projectId,
    fetch: config.fetch,
  });
}
