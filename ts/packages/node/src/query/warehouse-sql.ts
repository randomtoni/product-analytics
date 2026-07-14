import type {
  FunnelStepRow,
  QueryColumn,
  QueryResult,
  RetentionRow,
  TaxonomyShape,
  TrendRow,
} from '@randomtoni/analytics-kit';
import type { DbColumn, DbExecuteResult } from './db-execute';
import { EVENTS_VIEW } from './warehouse-schema';
import type {
  Aggregation,
  Duration,
  FunnelSpec,
  Granularity,
  RetentionSpec,
  TrendSpec,
  UniqueCountSpec,
} from './query-client';

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

// The funnel window as a canonical Postgres interval literal — the ONE serialization both trees
// emit byte-identically. Reuses S1's `INTERVAL_KEYWORD_FOR_WINDOW_UNIT` (minute/hour collapse to
// `hour`), so `{ value: 7, unit: 'day' }` → `interval '7 day'`. This is the sole determinism risk
// the architect flagged; pinning it to the same table trend uses removes it.
function windowIntervalLiteral(within: Duration): string {
  const keyword = INTERVAL_KEYWORD_FOR_WINDOW_UNIT[within.unit];
  return `interval '${within.value} ${keyword}'`;
}

// The per-actor ordered-step window walk as a SINGLE Postgres statement, structurally CONSTANT
// regardless of `steps.length` (only the VALUES rows + the recursion bound vary). It is a
// recursive step-chase: `anchor` fixes each actor's `t0 = min(timestamp)` of the step-0 event;
// the recursive term advances one step at a time, taking the EARLIEST next-step event that is
// STRICTLY after the prior step's `reached_at` (strict ordering) and within the CLOSED window
// `[t0, t0 + within]` (INCLUSIVE upper bound, `<=`). The aggregate lives in a scalar subquery,
// not the recursive term's SELECT list — Postgres forbids the latter (architect-verified against
// Postgres 18.4). The final SELECT LEFT JOINs the observed reaches back onto the step list so a
// step no actor reached still emits a zero row; counts are `count(distinct distinct_id)`.
//
// `run_max`-style window forms are deliberately NOT used: a running `max(step_index)` cannot honor
// the STRICT step-to-step inequality (equal-timestamp rows leak across), so it miscounts ties. The
// variadic N-way self-join is the other rejected alternative (join count grows with step count).
function funnelWalkSql(stepCount: number, within: Duration, breakdown: string | undefined): string {
  const windowInterval = windowIntervalLiteral(within);
  const valuesRows = Array.from({ length: stepCount }, (_, i) => `(${i}, $${i + 1})`).join(', ');
  const withinStep = `m.timestamp > w.reached_at AND m.timestamp <= w.t0 + ${windowInterval}`;

  if (breakdown === undefined) {
    return [
      'WITH RECURSIVE steps(step_index, event_name) AS (',
      `  VALUES ${valuesRows}`,
      '),',
      'matched AS (',
      '  SELECT e.distinct_id, s.step_index, e.timestamp',
      `  FROM ${EVENTS_VIEW} e`,
      '  JOIN steps s ON e.event = s.event_name',
      '),',
      'anchor AS (',
      '  SELECT distinct_id, min(timestamp) AS t0',
      '  FROM matched WHERE step_index = 0',
      '  GROUP BY distinct_id',
      '),',
      'walk AS (',
      '  SELECT a.distinct_id, 0 AS step_index, a.t0 AS reached_at, a.t0',
      '  FROM anchor a',
      '  UNION ALL',
      '  SELECT w.distinct_id, w.step_index + 1,',
      '    (SELECT min(m.timestamp) FROM matched m',
      `      WHERE m.distinct_id = w.distinct_id AND m.step_index = w.step_index + 1 AND ${withinStep}),`,
      '    w.t0',
      '  FROM walk w',
      `  WHERE w.step_index + 1 < ${stepCount}`,
      '    AND EXISTS (SELECT 1 FROM matched m',
      `      WHERE m.distinct_id = w.distinct_id AND m.step_index = w.step_index + 1 AND ${withinStep})`,
      ')',
      'SELECT s.step_index, s.event_name, count(DISTINCT w.distinct_id) AS actor_count',
      'FROM steps s',
      '  LEFT JOIN walk w ON w.step_index = s.step_index AND w.reached_at IS NOT NULL',
      'GROUP BY s.step_index, s.event_name',
      'ORDER BY s.step_index',
    ].join('\n');
  }

  const breakdownPath = `properties ->> ${quoteLiteral(breakdown)}`;
  return [
    'WITH RECURSIVE steps(step_index, event_name) AS (',
    `  VALUES ${valuesRows}`,
    '),',
    'matched AS (',
    `  SELECT e.distinct_id, s.step_index, e.timestamp, ${breakdownPath} AS bd`,
    `  FROM ${EVENTS_VIEW} e`,
    '  JOIN steps s ON e.event = s.event_name',
    '),',
    'anchor AS (',
    '  SELECT distinct_id, min(timestamp) AS t0, (array_agg(bd ORDER BY timestamp))[1] AS bd',
    '  FROM matched WHERE step_index = 0',
    '  GROUP BY distinct_id',
    '),',
    'walk AS (',
    '  SELECT a.distinct_id, 0 AS step_index, a.t0 AS reached_at, a.t0, a.bd',
    '  FROM anchor a',
    '  UNION ALL',
    '  SELECT w.distinct_id, w.step_index + 1,',
    '    (SELECT min(m.timestamp) FROM matched m',
    `      WHERE m.distinct_id = w.distinct_id AND m.step_index = w.step_index + 1 AND ${withinStep}),`,
    '    w.t0, w.bd',
    '  FROM walk w',
    `  WHERE w.step_index + 1 < ${stepCount}`,
    '    AND EXISTS (SELECT 1 FROM matched m',
    `      WHERE m.distinct_id = w.distinct_id AND m.step_index = w.step_index + 1 AND ${withinStep})`,
    ')',
    'SELECT s.step_index, s.event_name, w.bd AS breakdown, count(DISTINCT w.distinct_id) AS actor_count',
    'FROM steps s',
    '  LEFT JOIN walk w ON w.step_index = s.step_index AND w.reached_at IS NOT NULL',
    'GROUP BY s.step_index, s.event_name, w.bd',
    'ORDER BY w.bd, s.step_index',
  ].join('\n');
}

// The generated funnel SQL + positional params. Each step's event name is bound as a positional
// param ($1..$N in step order); `within` is inlined as a canonical interval literal; the breakdown
// key (when present) reaches the SQL as an escaped JSONB path, exactly as S1's trend breakdown does.
export function buildFunnelSql<TX extends TaxonomyShape>(spec: FunnelSpec<TX>): WarehouseQuery {
  return {
    sql: funnelWalkSql(spec.steps.length, spec.within, spec.breakdown),
    params: [...spec.steps],
  };
}

// The cohort self-join as a SINGLE Postgres statement producing a DENSE `cohorts × periods` grid.
// A cohort is the set of actors who did the cohort event (`$1`) in a `date_trunc(granularity,
// timestamp)` bucket, keyed by that bucket start (the neutral `cohort` label). For each cohort
// bucket and each period offset `0 .. periods-1`, the cell is `count(distinct distinct_id)` of
// cohort members who did the RETURN event (`$2`) in `cohort_bucket + offset * interval`.
//
// `period_index = 0` is the cohort's OWN period (the LOCKED convention): the offset-0 cell counts
// members who returned in the cohort's own bucket (`offset * interval = 0`), NOT the first
// subsequent bucket. This is the base cohort size measured via the return event — matching the
// `retentionCohorts` fixture (index 0 = the cohort itself).
//
// DENSE, bounded, deterministic: `generate_series(0, periods-1)` is CROSS JOINed against the
// distinct cohort buckets to build the full grid, and the distinct-actor counts are LEFT JOINed
// onto it, so every `(cohort, period_index)` cell emits a row — `coalesce(..., 0)` fills an empty
// cell with `0` rather than dropping it (no gaps). A return event past `periods-1` buckets lands
// on no grid cell and contributes to nothing (bounded window). The distinct-count is grouped per
// `(cohort_bucket, period_index[, breakdown])`, so an actor in two cohort buckets counts once in
// EACH cohort's cells — per-cohort, never global.
//
// With a breakdown, the cohort's breakdown value is anchored at the cohort event (`properties ->>
// key`, escaped exactly as trend/funnel), one grid per breakdown value; it is carried through the
// grid and the join and stringified onto every row.
function retentionWalkSql(
  periods: number,
  granularity: Granularity,
  breakdown: string | undefined
): string {
  const bucketFormat = BUCKET_FORMAT_FOR_UNIT[granularity];
  const offsetInterval = `(g.period_index * interval '1 ${granularity}')`;
  const lastPeriod = periods - 1;
  const bucketExpr = `date_trunc('${granularity}', timestamp)`;

  if (breakdown === undefined) {
    return [
      'WITH cohort AS (',
      `  SELECT distinct_id, ${bucketExpr} AS cohort_bucket`,
      `  FROM ${EVENTS_VIEW}`,
      '  WHERE event = $1',
      `  GROUP BY distinct_id, ${bucketExpr}`,
      '),',
      'returns AS (',
      `  SELECT distinct_id, ${bucketExpr} AS return_bucket`,
      `  FROM ${EVENTS_VIEW}`,
      '  WHERE event = $2',
      `  GROUP BY distinct_id, ${bucketExpr}`,
      '),',
      'buckets AS (SELECT DISTINCT cohort_bucket FROM cohort),',
      'grid AS (',
      '  SELECT b.cohort_bucket, p.period_index',
      '  FROM buckets b',
      `  CROSS JOIN generate_series(0, ${lastPeriod}) AS p(period_index)`,
      '),',
      'cells AS (',
      '  SELECT g.cohort_bucket, g.period_index, count(DISTINCT c.distinct_id) AS value',
      '  FROM grid g',
      '  JOIN cohort c ON c.cohort_bucket = g.cohort_bucket',
      `  JOIN returns r ON r.distinct_id = c.distinct_id AND r.return_bucket = g.cohort_bucket + ${offsetInterval}`,
      '  GROUP BY g.cohort_bucket, g.period_index',
      ')',
      `SELECT to_char(g.cohort_bucket, '${bucketFormat}') AS cohort, g.period_index AS period_index, coalesce(cells.value, 0) AS value`,
      'FROM grid g',
      '  LEFT JOIN cells ON cells.cohort_bucket = g.cohort_bucket AND cells.period_index = g.period_index',
      'ORDER BY g.cohort_bucket, g.period_index',
    ].join('\n');
  }

  const breakdownPath = `properties ->> ${quoteLiteral(breakdown)}`;
  return [
    'WITH cohort AS (',
    `  SELECT distinct_id, ${bucketExpr} AS cohort_bucket, ${breakdownPath} AS bd`,
    `  FROM ${EVENTS_VIEW}`,
    '  WHERE event = $1',
    `  GROUP BY distinct_id, ${bucketExpr}, ${breakdownPath}`,
    '),',
    'returns AS (',
    `  SELECT distinct_id, ${bucketExpr} AS return_bucket`,
    `  FROM ${EVENTS_VIEW}`,
    '  WHERE event = $2',
    `  GROUP BY distinct_id, ${bucketExpr}`,
    '),',
    'buckets AS (SELECT DISTINCT cohort_bucket, bd FROM cohort),',
    'grid AS (',
    '  SELECT b.cohort_bucket, b.bd, p.period_index',
    '  FROM buckets b',
    `  CROSS JOIN generate_series(0, ${lastPeriod}) AS p(period_index)`,
    '),',
    'cells AS (',
    '  SELECT g.cohort_bucket, g.bd, g.period_index, count(DISTINCT c.distinct_id) AS value',
    '  FROM grid g',
    '  JOIN cohort c ON c.cohort_bucket = g.cohort_bucket AND c.bd IS NOT DISTINCT FROM g.bd',
    `  JOIN returns r ON r.distinct_id = c.distinct_id AND r.return_bucket = g.cohort_bucket + ${offsetInterval}`,
    '  GROUP BY g.cohort_bucket, g.bd, g.period_index',
    ')',
    `SELECT to_char(g.cohort_bucket, '${bucketFormat}') AS cohort, g.period_index AS period_index, coalesce(cells.value, 0) AS value, g.bd AS breakdown`,
    'FROM grid g',
    '  LEFT JOIN cells ON cells.cohort_bucket = g.cohort_bucket AND cells.period_index = g.period_index AND cells.bd IS NOT DISTINCT FROM g.bd',
    'ORDER BY g.bd, g.cohort_bucket, g.period_index',
  ].join('\n');
}

// The generated retention SQL + positional params. The cohort event and return event are the
// two positional params (`$1` = cohortEvent, `$2` = returnEvent, in that order); `periods` and
// `granularity` are structural (the series bound + the truncation/offset unit) and inlined; the
// breakdown key (when present) reaches the SQL as an escaped JSONB path, exactly as trend/funnel.
export function buildRetentionSql<TX extends TaxonomyShape>(
  spec: RetentionSpec<TX>
): WarehouseQuery {
  return {
    sql: retentionWalkSql(spec.periods, spec.granularity, spec.breakdown),
    params: [spec.cohortEvent, spec.returnEvent],
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

// The funnel flat-row builder. The SQL yields one row per step (per breakdown group when broken
// down): `(step_index, event_name, actor_count[, breakdown])`. This flattens those positional
// count rows into neutral `FunnelStepRow`s — sourcing `event` from `spec.steps[step]` (the spec
// knows the neutral name; NOT the HTTP adapter's `custom_name → name → action_id` wire walk) and
// COMPUTING `conversionRate = count[step] / count[0]` per breakdown group, GUARDED so a zero
// step-0 count yields `0` on every step (no NaN/Infinity leak). Identical guard rule to the HTTP
// `buildFunnelRows` / the `funnelZeroFirstStep` fixture, so warehouse rows are byte-identical.
//
// Curried on `spec.steps` because both the `event` label and the per-group step-0 base come from
// data the flat count rows do not carry (the event name column echoes the step name, but the
// neutral source of truth is the spec). Reads cells by column name so a benign column reorder or
// the absence of the `breakdown` column never mis-maps.
export function buildFunnelRows(
  steps: ReadonlyArray<string>
): (result: DbExecuteResult) => ReadonlyArray<FunnelStepRow> {
  return (result) => {
    const stepIdx = columnIndex(result.columns, 'step_index');
    const countIdx = columnIndex(result.columns, 'actor_count');
    const breakdownIdx = columnIndex(result.columns, 'breakdown');

    // Collect the count per (breakdown-group, step) so conversionRate divides within its group.
    const countByGroupStep = new Map<string | undefined, Map<number, number>>();
    const groupOrder: Array<string | undefined> = [];
    for (const cells of result.rows) {
      const step = cells[stepIdx];
      const count = cells[countIdx];
      if (typeof step !== 'number' || typeof count !== 'number') {
        continue;
      }
      const breakdownCell = breakdownIdx === -1 ? undefined : cells[breakdownIdx];
      const group =
        breakdownCell === undefined || breakdownCell === null ? undefined : String(breakdownCell);
      let stepCounts = countByGroupStep.get(group);
      if (stepCounts === undefined) {
        stepCounts = new Map<number, number>();
        countByGroupStep.set(group, stepCounts);
        groupOrder.push(group);
      }
      stepCounts.set(step, count);
    }

    const rows: FunnelStepRow[] = [];
    for (const group of groupOrder) {
      const stepCounts = countByGroupStep.get(group);
      if (stepCounts === undefined) {
        continue;
      }
      const firstCount = stepCounts.get(0) ?? 0;
      for (const [step, count] of [...stepCounts.entries()].sort(([a], [b]) => a - b)) {
        const event = steps[step];
        if (event === undefined) {
          continue;
        }
        const conversionRate = firstCount === 0 ? 0 : count / firstCount;
        rows.push(
          group === undefined
            ? { step, event, count, conversionRate }
            : { step, event, count, conversionRate, breakdown: group }
        );
      }
    }
    return rows;
  };
}

// The retention flat-row builder. The SQL yields one row per DENSE `(cohort, period_index)` cell
// (per breakdown value when broken down): `(cohort, period_index, value[, breakdown])`. This
// flattens those positional cells into neutral `RetentionRow`s — one row per cell, `value: 0` for
// an empty cell (the grid is dense, so a zero cell is a present row, never a gap). Sources `cohort`
// + `periodIndex` + `value` straight from the flat cells (NOT the HTTP adapter's nested
// `date` + indexed `values[]` walk — the RULE `period_index=0 = the cohort's own period` is shared,
// the SHAPE is not). Reads cells by column name so a benign column reorder or the absence of the
// `breakdown` column never mis-maps.
export function buildRetentionRows(result: DbExecuteResult): ReadonlyArray<RetentionRow> {
  const cohortIdx = columnIndex(result.columns, 'cohort');
  const periodIdx = columnIndex(result.columns, 'period_index');
  const valueIdx = columnIndex(result.columns, 'value');
  const breakdownIdx = columnIndex(result.columns, 'breakdown');

  const rows: RetentionRow[] = [];
  for (const cells of result.rows) {
    const cohort = cells[cohortIdx];
    const periodIndex = cells[periodIdx];
    const value = cells[valueIdx];
    if (typeof cohort !== 'string' || typeof periodIndex !== 'number' || typeof value !== 'number') {
      continue;
    }
    const breakdownCell = breakdownIdx === -1 ? undefined : cells[breakdownIdx];
    const breakdown =
      breakdownCell === undefined || breakdownCell === null ? undefined : String(breakdownCell);
    rows.push(
      breakdown === undefined
        ? { cohort, periodIndex, value }
        : { cohort, periodIndex, value, breakdown }
    );
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
