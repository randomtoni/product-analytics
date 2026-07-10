import type { Taxonomy, TaxonomyDecl } from 'analytics-kit';
import type { FetchLike } from '../config';

// The query client's own server-only config surface — DISTINCT from the ingest
// `NodeAnalyticsConfig`. Query uses a server personal/read key against a config-supplied
// query host + project scope; none of these fields alias the ingest write `key`/`ingestHost`.
// Personal-key handling is server-side only — never shipped to the browser bundle.
export interface QueryClientConfig {
  queryEndpoint?: string;
  personalKey?: string;
  projectId?: string;
  taxonomy?: Taxonomy<TaxonomyDecl>;
  fetch?: FetchLike;
}
