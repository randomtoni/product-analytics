import type {
  FunnelStepRow,
  QueryResult,
  RetentionRow,
  TaxonomyShape,
  TrendRow,
  UniqueCountRow,
} from '@randomtoni/analytics-kit';
import type { AnalyticsQueryClient } from './query-client';

// The silent no-op query client. Selected by the factory when `personalKey` is absent
// (or set but with no `queryEndpoint`), so "unkeyed ⇒ queries nothing" is a property of
// this null object rather than a scattered `disabled` flag. Every method resolves to a
// well-formed zero-row `QueryResult` — a snapshot job in an unconfigured env gets empty
// data, never an exception. No network is ever touched; no adapter is constructed.
//
// It implements the narrow `AnalyticsQueryClient` — NOT the seam's wider `AnalyticsAdapter`;
// the query client is a standalone read surface, so only the null-object PATTERN is reused
// from `NodeNoop`.
export class QueryNoop<TX extends TaxonomyShape> implements AnalyticsQueryClient<TX> {
  async funnel(): Promise<QueryResult<FunnelStepRow>> {
    return emptyResult<FunnelStepRow>();
  }

  async retention(): Promise<QueryResult<RetentionRow>> {
    return emptyResult<RetentionRow>();
  }

  async trend(): Promise<QueryResult<TrendRow>> {
    return emptyResult<TrendRow>();
  }

  async uniqueCount(): Promise<QueryResult<UniqueCountRow>> {
    return emptyResult<UniqueCountRow>();
  }

  async rawQuery(): Promise<QueryResult> {
    return emptyResult();
  }
}

function emptyResult<TRow>(): QueryResult<TRow> {
  return { rows: [], columns: [], generatedAt: new Date().toISOString() };
}
