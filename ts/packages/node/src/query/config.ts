import type { Taxonomy, TaxonomyDecl } from '@randomtoni/analytics-kit';
import type { FetchLike } from '../config';

// The query client's own server-only config surface — DISTINCT from the ingest
// `NodeAnalyticsConfig`. Query uses a server personal/read key against a config-supplied
// query host + project scope; none of these fields alias the ingest write `key`/`ingestHost`.
// Personal-key handling is server-side only — never shipped to the browser bundle.
export interface QueryClientConfig {
  // The warehouse DSN — the explicit self-host signal. Its PRESENCE selects the warehouse query
  // adapter (the first rung of `createQueryClient`), which reads over the consumer's own Postgres
  // rather than a query host. Shares its SHAPE with E19's receiver-config field so self-host is
  // one coherent "here's my Neon" across read and write. A credential-shaped value: read at the
  // factory boundary, never stored on the working adapter.
  warehouseDsn?: string;
  queryEndpoint?: string;
  personalKey?: string;
  projectId?: string;
  taxonomy?: Taxonomy<TaxonomyDecl>;
  fetch?: FetchLike;
}
