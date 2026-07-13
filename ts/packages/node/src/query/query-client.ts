import type {
  FunnelStepRow,
  QueryResult,
  RetentionRow,
  TaxonomyShape,
  TrendRow,
  UniqueCountRow,
} from '@randomtoni/analytics-kit';

export interface Duration {
  value: number;
  unit: 'minute' | 'hour' | 'day' | 'week' | 'month';
}

export type Granularity = 'day' | 'week' | 'month';

export type Aggregation = 'total' | 'unique' | 'dau';

export interface FunnelSpec<TX extends TaxonomyShape> {
  steps: Array<keyof TX['events'] & string>;
  within: Duration;
  breakdown?: string;
}

export interface RetentionSpec<TX extends TaxonomyShape> {
  cohortEvent: keyof TX['events'] & string;
  returnEvent: keyof TX['events'] & string;
  periods: number;
  granularity: Granularity;
  breakdown?: string;
}

export interface TrendSpec<TX extends TaxonomyShape> {
  event: keyof TX['events'] & string;
  aggregation: Aggregation;
  window: Duration;
  breakdown?: string;
}

export interface UniqueCountSpec<TX extends TaxonomyShape> {
  event: keyof TX['events'] & string;
  window: Duration;
  breakdown?: string;
}

export interface AnalyticsQueryClient<TX extends TaxonomyShape> {
  funnel(spec: FunnelSpec<TX>): Promise<QueryResult<FunnelStepRow>>;
  retention(spec: RetentionSpec<TX>): Promise<QueryResult<RetentionRow>>;
  trend(spec: TrendSpec<TX>): Promise<QueryResult<TrendRow>>;
  uniqueCount(spec: UniqueCountSpec<TX>): Promise<QueryResult<UniqueCountRow>>;
  rawQuery(expr: string): Promise<QueryResult>;
}
