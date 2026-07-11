import { createQueryClient } from '@randomtoni/analytics-kit-node';
import type { AnalyticsQueryClient, QueryClientConfig } from '@randomtoni/analytics-kit-node';
import type { QueryResult } from '@randomtoni/analytics-kit';
import { fernlyTaxonomy, type FernlyTaxonomy } from '../taxonomy';

export type FernlyQueryClient = AnalyticsQueryClient<ShapeOfFernly>;
type ShapeOfFernly = ReturnType<typeof createQueryClient<FernlyTaxonomy['decl']>> extends AnalyticsQueryClient<
  infer TX
>
  ? TX
  : never;

export type FernlyQueryConfig = Omit<QueryClientConfig, 'taxonomy'>;

export function createFernlyQueryClient(config: FernlyQueryConfig): FernlyQueryClient {
  return createQueryClient({ ...config, taxonomy: fernlyTaxonomy });
}

// A consumer-owned snapshot record: the neutral QueryResult a persistence job stores,
// wrapped with Fernly's own naming + capture timestamp. Snapshot STORAGE lives here in
// the example, never in the library — the library owns only the query primitives.
export interface SnapshotRecord {
  name: string;
  capturedAt: string;
  result: QueryResult;
}

function snapshot(name: string, result: QueryResult): SnapshotRecord {
  return { name, capturedAt: new Date().toISOString(), result };
}

export async function activationFunnelSnapshot(client: FernlyQueryClient): Promise<SnapshotRecord> {
  const result = await client.funnel({
    steps: ['signup_started', 'signup_completed', 'document_uploaded'],
    within: { value: 7, unit: 'day' },
  });
  return snapshot('activation_funnel', result);
}

export async function reviewerRetentionSnapshot(client: FernlyQueryClient): Promise<SnapshotRecord> {
  const result = await client.retention({
    cohortEvent: 'signup_completed',
    returnEvent: 'review_completed',
    periods: 8,
    granularity: 'week',
  });
  return snapshot('reviewer_retention', result);
}

export async function commentEngagementSnapshot(client: FernlyQueryClient): Promise<SnapshotRecord> {
  const result = await client.trend({
    event: 'comment_added',
    aggregation: 'total',
    window: { value: 30, unit: 'day' },
  });
  return snapshot('comment_engagement', result);
}

export async function activeReviewersSnapshot(client: FernlyQueryClient): Promise<SnapshotRecord> {
  const result = await client.uniqueCount({
    event: 'review_requested',
    window: { value: 30, unit: 'day' },
  });
  return snapshot('active_reviewers', result);
}

export async function plansMixSnapshot(client: FernlyQueryClient): Promise<SnapshotRecord> {
  const result = await client.rawQuery(
    "SELECT properties.toPlan AS plan, count() AS upgrades FROM events WHERE event = 'plan_upgraded' GROUP BY plan"
  );
  return snapshot('plans_mix', result);
}

export async function allFernlySnapshots(client: FernlyQueryClient): Promise<SnapshotRecord[]> {
  return Promise.all([
    activationFunnelSnapshot(client),
    reviewerRetentionSnapshot(client),
    commentEngagementSnapshot(client),
    activeReviewersSnapshot(client),
    plansMixSnapshot(client),
  ]);
}
