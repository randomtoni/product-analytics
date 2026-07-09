import type { DefaultTaxonomyShape, ShapeOf, Taxonomy, TaxonomyDecl } from 'analytics-kit';
import type { NodeAnalyticsConfig } from './config';
import { type NodeAnalytics, NodeAnalyticsClient } from './node-analytics';
import { NodeNoop } from './node-noop';
import { createSendBatch, type NodeFetch } from './send-batch';

export function createAnalytics<const T extends TaxonomyDecl>(
  config: NodeAnalyticsConfig & { taxonomy: Taxonomy<T> }
): NodeAnalytics<ShapeOf<T>>;
export function createAnalytics(config: NodeAnalyticsConfig): NodeAnalytics<DefaultTaxonomyShape>;
export function createAnalytics(
  config: NodeAnalyticsConfig
): NodeAnalytics<DefaultTaxonomyShape> {
  // Unkeyed ⇒ a whole-stack silent no-op: the null-object client sends nothing, never
  // constructs the queue/transport, and its lifecycle verbs resolve immediately (bar B —
  // config-only adoption, an unconfigured environment sends nothing). Mirrors the browser
  // factory pattern (create-analytics.ts) but uses node's OWN null object, since the seam
  // `NoopAdapter` implements the wider `AnalyticsAdapter`, not node's `NodeAnalytics`.
  if (config.key === undefined) {
    return new NodeNoop<DefaultTaxonomyShape>();
  }
  // The transport: the consumer-injected `fetch`, else the Node 18+ global. Both satisfy
  // node's own minimal fetch contract (only `.status` is read).
  const fetchImpl = (config.fetch ?? fetch) as NodeFetch;
  const send = createSendBatch({ config, fetchImpl });
  return new NodeAnalyticsClient(config, send);
}
