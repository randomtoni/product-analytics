import type { FlagsConfig, Taxonomy, TaxonomyDecl } from '@randomtoni/analytics-kit';
import type { FetchLike } from '../config';
import type { FeatureFlagDefinition } from './local/neutral-definition';

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
//
// The fully-local self-host posture (the recommended zero-infra default) supplies `staticDefinitions`
// instead of a definitions endpoint: the consumer seeds the definition set from config, so the
// definition SOURCE moves off the poller fetch and the client makes ZERO `/flags/` calls and has no
// flag/definitions URL. The canonical shape is `key` + `staticDefinitions` + `onlyEvaluateLocally:
// true`, with NO `definitionsEndpoint` / `definitionsKey` / `flagEndpoint`.
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
  // Consumer-supplied STATIC flag definitions (the neutral S1 `FeatureFlagDefinition` shape). Present
  // ⇒ the local-eval snapshot is SEEDED from these (via S1's lowering), bypassing the poller fetch
  // entirely — no definitions endpoint / privileged credential required. Validated loudly at client
  // construction; malformed definitions throw. This is the recommended zero-infra self-host default.
  staticDefinitions?: FeatureFlagDefinition[];
  // Suppress the remote fallback: an inconclusive flag under local-only resolves to its degraded
  // neutral state rather than round-tripping. Effective = `onlyEvaluateLocally ?? false`.
  onlyEvaluateLocally?: boolean;
}
