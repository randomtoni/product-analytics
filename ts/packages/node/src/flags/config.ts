import type { FlagsConfig, Taxonomy, TaxonomyDecl } from 'analytics-kit';
import type { FetchLike } from '../config';

// The flag client's own server-only config surface — DISTINCT from the ingest
// `NodeAnalyticsConfig` and from the query `QueryClientConfig`. The flag round-trip has its own
// endpoint (a flag-eval decision endpoint, not the ingest write endpoint), authenticated by the
// project `key` sent in-body, exactly as query points at its own read endpoint. `bootstrap` is a
// minimal SSR request-scoped seed/fallback — the server path is remote-round-trip-primary.
export interface FlagClientConfig {
  key?: string;
  flagEndpoint?: string;
  taxonomy?: Taxonomy<TaxonomyDecl>;
  bootstrap?: FlagsConfig['bootstrap'];
  fetch?: FetchLike;
}
