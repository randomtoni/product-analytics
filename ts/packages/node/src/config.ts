import type { Taxonomy, TaxonomyDecl, ViolationPolicy } from 'analytics-kit';

export type { ViolationPolicy };

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
