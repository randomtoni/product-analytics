import type { DefaultTaxonomyShape, ShapeOf, Taxonomy, TaxonomyDecl } from 'analytics-kit';
import type { NodeAnalyticsConfig } from './config';
import { type NodeAnalytics, NodeAnalyticsClient } from './node-analytics';
import { createSendBatch, type NodeFetch } from './send-batch';

export function createAnalytics<const T extends TaxonomyDecl>(
  config: NodeAnalyticsConfig & { taxonomy: Taxonomy<T> }
): NodeAnalytics<ShapeOf<T>>;
export function createAnalytics(config: NodeAnalyticsConfig): NodeAnalytics<DefaultTaxonomyShape>;
export function createAnalytics(
  config: NodeAnalyticsConfig
): NodeAnalytics<DefaultTaxonomyShape> {
  // The transport: the consumer-injected `fetch`, else the Node 18+ global. Both satisfy
  // node's own minimal fetch contract (only `.status` is read).
  const fetchImpl = (config.fetch ?? fetch) as NodeFetch;
  const send = createSendBatch({ config, fetchImpl });
  // Unkeyed ⇒ whole-stack no-op resolution lands in E7-S6; the skeleton constructs the
  // real client regardless (its buffer stub never sends).
  return new NodeAnalyticsClient(config, send);
}
