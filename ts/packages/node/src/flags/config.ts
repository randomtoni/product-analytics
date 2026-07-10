import type { FlagsConfig, Taxonomy, TaxonomyDecl } from 'analytics-kit';
import type { FetchLike } from '../config';

// The flag client's own server-only config surface — DISTINCT from the ingest
// `NodeAnalyticsConfig` and from the query `QueryClientConfig`. The flag round-trip has its own
// endpoint (a flag-eval decision endpoint, not the ingest write endpoint), authenticated by the
// project `key` sent in-body, exactly as query points at its own read endpoint. `bootstrap` is a
// minimal SSR request-scoped seed/fallback — the server path is remote-round-trip-primary.
//
// Local (in-process) evaluation is enabled adapter-internally by config alone (bar B): a
// `definitionsEndpoint` + a privileged `definitionsKey` turn on the definition poller + evaluator;
// the local-vs-remote strategy stays entirely behind the unchanged `evaluate`, never on the neutral
// port. `onlyEvaluateLocally` is ADAPTER config, resolved from this object — never a neutral port
// parameter. A browser adapter (no local mode) would simply ignore it.
export interface FlagClientConfig {
  key?: string;
  flagEndpoint?: string;
  taxonomy?: Taxonomy<TaxonomyDecl>;
  bootstrap?: FlagsConfig['bootstrap'];
  fetch?: FetchLike;
  // The definition-list origin the poller reads flag DEFINITIONS from (distinct from the remote
  // `flagEndpoint`). Presence + `definitionsKey` selects a local-capable adapter.
  definitionsEndpoint?: string;
  // The privileged (definition-reading) credential authorizing the definition fetch — named by ROLE,
  // never a vendor key name. Distinct from the ingest write key and the remote-eval project `key`.
  definitionsKey?: string;
  // The definition poll interval in milliseconds. Defaults to a sensible interval when omitted.
  pollInterval?: number;
  // Suppress the remote fallback: an inconclusive flag under local-only resolves to its degraded
  // neutral state rather than round-tripping. Effective = `onlyEvaluateLocally ?? false`.
  onlyEvaluateLocally?: boolean;
}
