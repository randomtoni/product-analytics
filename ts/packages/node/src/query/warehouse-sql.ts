import type { QueryColumn, QueryResult, TaxonomyShape, TrendRow } from '@randomtoni/analytics-kit';
import type { DbColumn, DbExecuteResult } from './db-execute';
import { EVENTS_VIEW } from './warehouse-schema';
import type { Aggregation, Duration, TrendSpec, UniqueCountSpec } from './query-client';

// The warehouse SQL-generation module: pure builder functions that emit Postgres SQL over the
// E17 taxonomy-generated typed VIEW (`EVENTS_VIEW`), plus the shared assembler that normalizes a
// driver's `DbExecuteResult` into the neutral `QueryResult`. It imports no database driver and
// executes nothing — a caller routes the emitted SQL through the injected `DbExecute` seam. The
// trend/unique_count builder is the first resident; funnel/retention/raw builders (S2–S4) join it.
//
// Never targets the base `events` table and never reads `properties` directly EXCEPT the breakdown
// path (`properties ->> '<key>'`) — breakdown is a runtime string, not a typed view column, so it
// reads the JSONB path; the bucketed/counted columns come from the view.

// Single-quote a SQL string literal — the same escaping `warehouse-schema.ts` applies to consumer
// keys, kept consistent so the breakdown JSONB key path and the view generator share one story.
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// The `date_trunc` bucket unit, mirroring the HTTP adapter's `INTERVAL_FOR_UNIT`: minute/hour
// collapse to `hour`; day/week/month pass through. A closed enum lookup (never free text), so
// interpolating the result into the SQL is safe — the same discipline `CAST_TYPE` uses.
const BUCKET_UNIT_FOR_WINDOW_UNIT: Record<Duration['unit'], string> = {
  minute: 'hour',
  hour: 'hour',
  day: 'day',
  week: 'week',
  month: 'month',
};

// The plural interval keyword for the `generate_series` step and the window lower bound. Derived
// from the same window unit; a fixed table, so the emitted interval literal is deterministic.
const INTERVAL_KEYWORD_FOR_WINDOW_UNIT: Record<Duration['unit'], string> = {
  minute: 'hour',
  hour: 'hour',
  day: 'day',
  week: 'week',
  month: 'month',
};

// The `to_char` format per bucket unit. `to_char` is immune to session `DateStyle`/`TimeZone`, so
// the emitted bucket string is deterministic regardless of the consumer's driver settings. Hour
// buckets carry the time component (`...T14:00:00`); day/week/month render a bare ISO date — the
// exact shape the frozen row fixtures pin (`'2026-07-01'`).
const BUCKET_FORMAT_FOR_UNIT: Record<string, string> = {
  hour: 'YYYY-MM-DD"T"HH24:00:00',
  day: 'YYYY-MM-DD',
  week: 'YYYY-MM-DD',
  month: 'YYYY-MM-DD',
};

// `count(*)` for `total`; `count(distinct distinct_id)` for `unique`/`dau`. unique_count is always
// distinct actors, so it maps to the same distinct count without an aggregation field.
function countExpr(aggregation: Aggregation): string {
  return aggregation === 'total' ? 'count(*)' : 'count(distinct distinct_id)';
}

interface TrendWalk {
  countExpr: string;
  window: Duration;
  breakdown: string | undefined;
}

// Emit the shared trend walk as Postgres SQL over the typed view. A `generate_series` spine over
// the window at the bucket interval is LEFT JOINed to the grouped counts so an empty bucket yields
// `value: 0`, never a gap. With a breakdown, the spine is CROSS JOINed against the OBSERVED
// breakdown values (each series present in the window is dense over the spine; a value the window
// never produced is not a series and nothing is filled for it). The event name is the ONE value
// bound as a positional param (`$1`); the interval/unit/format are structural and inlined.
function trendWalkSql(walk: TrendWalk): string {
  const bucketUnit = BUCKET_UNIT_FOR_WINDOW_UNIT[walk.window.unit];
  const intervalKeyword = INTERVAL_KEYWORD_FOR_WINDOW_UNIT[walk.window.unit];
  const bucketFormat = BUCKET_FORMAT_FOR_UNIT[bucketUnit];
  const stepInterval = `interval '1 ${intervalKeyword}'`;
  const windowInterval = `interval '${walk.window.value} ${intervalKeyword}'`;

  const lowerBound = `date_trunc('${bucketUnit}', now() - ${windowInterval})`;
  const upperBound = `date_trunc('${bucketUnit}', now())`;
  const spine = `generate_series(${lowerBound}, ${upperBound}, ${stepInterval})`;
  const bucketLabel = `to_char(spine.bucket, '${bucketFormat}')`;

  if (walk.breakdown === undefined) {
    return [
      'WITH counts AS (',
      `  SELECT date_trunc('${bucketUnit}', timestamp) AS bucket, ${walk.countExpr} AS value`,
      `  FROM ${EVENTS_VIEW}`,
      `  WHERE event = $1 AND timestamp >= ${lowerBound}`,
      `  GROUP BY date_trunc('${bucketUnit}', timestamp)`,
      ')',
      `SELECT ${bucketLabel} AS bucket, coalesce(counts.value, 0) AS value`,
      `FROM ${spine} AS spine(bucket)`,
      '  LEFT JOIN counts ON counts.bucket = spine.bucket',
      'ORDER BY spine.bucket',
    ].join('\n');
  }

  const breakdownPath = `properties ->> ${quoteLiteral(walk.breakdown)}`;
  return [
    'WITH counts AS (',
    `  SELECT date_trunc('${bucketUnit}', timestamp) AS bucket, ${breakdownPath} AS breakdown, ${walk.countExpr} AS value`,
    `  FROM ${EVENTS_VIEW}`,
    `  WHERE event = $1 AND timestamp >= ${lowerBound}`,
    `  GROUP BY date_trunc('${bucketUnit}', timestamp), ${breakdownPath}`,
    '),',
    'series AS (SELECT DISTINCT breakdown FROM counts)',
    `SELECT ${bucketLabel} AS bucket, coalesce(counts.value, 0) AS value, series.breakdown AS breakdown`,
    `FROM ${spine} AS spine(bucket)`,
    '  CROSS JOIN series',
    '  LEFT JOIN counts ON counts.bucket = spine.bucket AND counts.breakdown IS NOT DISTINCT FROM series.breakdown',
    'ORDER BY series.breakdown, spine.bucket',
  ].join('\n');
}

// The generated SQL + positional params for a trend/unique_count query. `params` carries the ONE
// consumer value (the event name); everything else is inlined structural SQL.
export interface WarehouseQuery {
  sql: string;
  params: ReadonlyArray<unknown>;
}

export function buildTrendSql<TX extends TaxonomyShape>(spec: TrendSpec<TX>): WarehouseQuery {
  return {
    sql: trendWalkSql({
      countExpr: countExpr(spec.aggregation),
      window: spec.window,
      breakdown: spec.breakdown,
    }),
    params: [spec.event],
  };
}

export function buildUniqueCountSql<TX extends TaxonomyShape>(
  spec: UniqueCountSpec<TX>
): WarehouseQuery {
  return {
    sql: trendWalkSql({
      // unique_count is always distinct actors — the `unique`/`dau` count expression.
      countExpr: countExpr('unique'),
      window: spec.window,
      breakdown: spec.breakdown,
    }),
    params: [spec.event],
  };
}

// The index of each named column in a `DbExecuteResult` row, so a flat-row builder reads
// positional cells by name once rather than hard-coding offsets. The warehouse SELECT names its
// columns (`bucket`, `value`, optional `breakdown`), so the driver reports them in `columns`.
function columnIndex(columns: ReadonlyArray<DbColumn>, name: string): number {
  return columns.findIndex((c) => c.name === name);
}

// A per-primitive flat-row builder: flattens the positional cells of a `DbExecuteResult` into the
// primitive's neutral rows. The warehouse analog of the HTTP adapter's `buildTrendRows`, but over
// FLAT tabular cells (not engine-nested `days`/`data`). Reads cells by column name so a benign
// column-order change never mis-maps.
export function buildTrendRows(result: DbExecuteResult): ReadonlyArray<TrendRow> {
  const bucketIdx = columnIndex(result.columns, 'bucket');
  const valueIdx = columnIndex(result.columns, 'value');
  const breakdownIdx = columnIndex(result.columns, 'breakdown');

  const rows: TrendRow[] = [];
  for (const cells of result.rows) {
    const bucket = cells[bucketIdx];
    const value = cells[valueIdx];
    if (typeof bucket !== 'string' || typeof value !== 'number') {
      continue;
    }
    const breakdownCell = breakdownIdx === -1 ? undefined : cells[breakdownIdx];
    const breakdown =
      breakdownCell === undefined || breakdownCell === null ? undefined : String(breakdownCell);
    rows.push(breakdown === undefined ? { bucket, value } : { bucket, value, breakdown });
  }
  return rows;
}

// A flat-row builder: a `DbExecuteResult` in, the primitive's neutral rows out. Sibling of the
// HTTP adapter's `RowBuilder`, but its source is the positional `DbExecuteResult` rather than a
// wire envelope. S2–S4 each supply their own.
export type WarehouseRowBuilder<TRow> = (result: DbExecuteResult) => ReadonlyArray<TRow>;

// The shared assembler — the warehouse analog of the HTTP adapter's `normalizeResult`. Takes a
// `DbExecuteResult` + a flat-row builder and produces a neutral `QueryResult`: it stamps `columns`
// from the driver-reported SELECT schema (`DbColumn` → `QueryColumn`, carrying `type` only when
// present) and `generatedAt`, and OMITS `fromCache` (a live SQL exec has no cache envelope — the
// optional field is left off, never fabricated). Unlike the HTTP structured path (which forces
// `columns: []`), the warehouse STAMPS `columns`: they are the neutral SELECT schema, not engine
// wire tokens. S2–S4 reuse this verbatim, threading only their own flat-row builder.
export function assembleResult<TRow>(
  result: DbExecuteResult,
  rowBuilder: WarehouseRowBuilder<TRow>
): QueryResult<TRow> {
  const columns: QueryColumn[] = result.columns.map((column) =>
    column.type === undefined ? { name: column.name } : { name: column.name, type: column.type }
  );
  return {
    rows: rowBuilder(result),
    columns,
    generatedAt: new Date().toISOString(),
  };
}
