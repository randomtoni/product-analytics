export interface QueryColumn {
  name: string;
  type?: string;
}

export interface QueryResult<TRow = Record<string, unknown>> {
  rows: ReadonlyArray<TRow>;
  columns: ReadonlyArray<QueryColumn>;
  generatedAt: string;
  fromCache?: boolean;
}

export interface TrendRow {
  bucket: string;
  value: number;
  breakdown?: string;
}

export type UniqueCountRow = TrendRow;

export interface FunnelStepRow {
  step: number;
  event: string;
  count: number;
  conversionRate: number;
  breakdown?: string;
}

export interface RetentionRow {
  cohort: string;
  periodIndex: number;
  value: number;
  breakdown?: string;
}
