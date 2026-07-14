export const version = '0.1.0';

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
  EVENTS_TABLE,
  EVENTS_TABLE_DDL,
  EVENTS_VIEW,
  buildTypedViewSql,
  buildMigrationSql,
} from './query/warehouse-schema';
export type { DbExecute, DbExecuteResult, DbColumn } from './query/db-execute';
export { createDefaultDbExecute } from './query/default-db-execute';
export type { DefaultDbExecuteConfig } from './query/default-db-execute';
export { createReceiver } from './receiver';
export type { Receiver, ReceiverHeaders, ReceiveOutcome } from './receiver';
export { createFlagClient } from './flags/create-flag-client';
export type { NodeFlagClient } from './flags/create-flag-client';
export type { FlagClientConfig } from './flags/config';
export type {
  FeatureFlagPort,
  FlagContext,
  FlagEvaluateOptions,
  FlagSet,
  FlagValue,
  FlagReason,
} from '@randomtoni/analytics-kit';
