import type { Taxonomy, TaxonomyDecl } from 'analytics-kit';

// The seam's off-list policy, mirrored locally: `enforceAllowlist` accepts this union
// structurally, but the seam entrypoint does not re-export the `ViolationPolicy` name.
export type ViolationPolicy = 'throw' | 'drop-and-error-log';

// The transport primitive: a consumer-injectable fetch implementation so the consumer
// can supply a first-party proxy or a runtime-specific fetch. Consumed by E7-S4's
// batch delivery; declared here so the config surface is stable from S2 on.
export type FetchLike = typeof fetch;

export interface NodeAnalyticsConfig {
  key?: string;
  taxonomy?: Taxonomy<TaxonomyDecl>;
  allowlist?: string[];
  onViolation?: ViolationPolicy;
  ingestHost?: string;
  ingestPath?: string;
  fetch?: FetchLike;
  flushAt?: number;
  flushInterval?: number;
  maxBatchSize?: number;
  maxQueueSize?: number;
  shutdownTimeoutMs?: number;
}
