export const version = '0.0.0';

export { createAnalytics } from './create-analytics';
export type { NodeAnalytics, NodeCapture, CaptureOptions } from './node-analytics';
export type { NodeAnalyticsConfig, FetchLike } from './config';
export type {
  AnalyticsQueryClient,
  FunnelSpec,
  RetentionSpec,
  TrendSpec,
  UniqueCountSpec,
  Duration,
  Granularity,
  Aggregation,
} from './query/query-client';
export { createQueryClient } from './query/create-query-client';
export type { QueryClientConfig } from './query/config';
export {
  HttpQueryAdapter,
  createHttpQueryAdapter,
} from './query/http-query-adapter';
export type { HttpQueryAdapterOptions } from './query/http-query-adapter';
