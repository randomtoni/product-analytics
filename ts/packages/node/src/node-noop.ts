import type { TaxonomyShape } from '@randomtoni/analytics-kit';
import type { NodeAnalytics, NodeCapture } from './node-analytics';

// The whole-stack silent no-op node client. Selected by the factory when `config.key`
// is absent, so "unkeyed ⇒ sends nothing" is a property of this null object rather than
// a scattered `disabled` flag inside the real client. Every verb accepts calls and does
// nothing; the queue and transport are never constructed. `flush`/`shutdown` resolve
// immediately so a consumer in an unkeyed environment never blocks on lifecycle calls.
//
// It implements the narrow `NodeAnalytics` client interface — NOT the seam's wider
// `AnalyticsAdapter`; node is a standalone client (shape A), so the seam's `NoopAdapter`
// does not structurally satisfy this surface. Only the null-object PATTERN is reused.
export class NodeNoop<TX extends TaxonomyShape> implements NodeAnalytics<TX> {
  capture: NodeCapture<TX> = (() => {}) as NodeCapture<TX>;

  setTraits(): void {}

  setGroupTraits(): void {}

  async flush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}
