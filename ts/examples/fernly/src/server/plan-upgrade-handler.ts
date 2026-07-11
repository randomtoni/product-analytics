import { createAnalytics } from '@randomtoni/analytics-kit-node';
import type { NodeAnalytics, NodeAnalyticsConfig } from '@randomtoni/analytics-kit-node';
import { fernlyTaxonomy, type FernlyTaxonomy } from '../taxonomy';

export type FernlyServerAnalytics = NodeAnalytics<ShapeOfFernly>;
type ShapeOfFernly = ReturnType<typeof createAnalytics<FernlyTaxonomy['decl']>> extends NodeAnalytics<
  infer TX
>
  ? TX
  : never;

export type FernlyServerConfig = Omit<NodeAnalyticsConfig, 'taxonomy'>;

export function createFernlyServerAnalytics(config: FernlyServerConfig): FernlyServerAnalytics {
  return createAnalytics({ ...config, taxonomy: fernlyTaxonomy });
}

export interface PlanUpgrade {
  reviewerId: string;
  reviewerEmail: string;
  role: string;
  workspaceKey: string;
  workspaceName: string;
  seats: number;
  fromPlan: string;
  toPlan: string;
  at: Date;
  billingEventId: string;
}

export function handlePlanUpgrade(
  analytics: FernlyServerAnalytics,
  upgrade: PlanUpgrade
): void {
  analytics.capture(
    upgrade.reviewerId,
    'plan_upgraded',
    { fromPlan: upgrade.fromPlan, toPlan: upgrade.toPlan, at: upgrade.at },
    { dedupeId: upgrade.billingEventId }
  );

  analytics.setTraits(upgrade.reviewerId, {
    role: upgrade.role,
    plan: upgrade.toPlan,
    email: upgrade.reviewerEmail,
  });
  analytics.setGroupTraits('workspace', upgrade.workspaceKey, {
    name: upgrade.workspaceName,
    seats: upgrade.seats,
  });
}

export function createShutdownHandler(analytics: FernlyServerAnalytics): () => Promise<void> {
  return async () => {
    await analytics.shutdown();
  };
}

export function registerShutdownHandler(analytics: FernlyServerAnalytics): () => Promise<void> {
  const handler = createShutdownHandler(analytics);
  process.once('SIGTERM', handler);
  process.once('SIGINT', handler);
  return handler;
}
