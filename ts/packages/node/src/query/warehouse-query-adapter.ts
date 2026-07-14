import type {
  FunnelStepRow,
  QueryResult,
  RetentionRow,
  TaxonomyShape,
  TrendRow,
  UniqueCountRow,
} from '@randomtoni/analytics-kit';
import type { DbExecute } from './db-execute';
import { createDefaultDbExecute } from './default-db-execute';
import type {
  AnalyticsQueryClient,
  FunnelSpec,
  RetentionSpec,
  TrendSpec,
  UniqueCountSpec,
} from './query-client';
import {
  assembleResult,
  buildFunnelRows,
  buildFunnelSql,
  buildRetentionRows,
  buildRetentionSql,
  buildTrendRows,
  buildTrendSql,
  buildUniqueCountSql,
} from './warehouse-sql';

const NOT_IMPLEMENTED = 'analytics: warehouse query adapter is not yet implemented';

// A second query backend, named by ROLE (never a vendor). It is a TYPED STUB for R1: every
// member satisfies `AnalyticsQueryClient<TX>` and typechecks, but no method computes — each
// throws a neutral not-implemented error. Its reason to exist is the bar-A proof: a second
// adapter satisfies the same neutral interface as `HttpQueryAdapter`, unchanged.
//
// Intended per-method SQL mapping (the fill-in seat):
// The first real fill-in emits Postgres SQL over the taxonomy-generated typed VIEW (safe-cast
// projections over the JSONB base — never raw JSONB, never DuckDB-first). Each method targets
// the view's columns generically; NO consumer event/domain name is baked into any SQL here.
//
//   funnel(spec)      SELECT ordered step-completion counts from the typed view, restricting to
//                     the spec.steps in order, keeping only distinct_ids whose step timestamps
//                     fall inside spec.within; GROUP BY spec.breakdown when present.
//   retention(spec)   Self-join the typed view: cohort rows (spec.cohortEvent) against return
//                     rows (spec.returnEvent) bucketed by spec.granularity for spec.periods
//                     periods; GROUP BY spec.breakdown when present.
//   trend(spec)       SELECT a time series over spec.window at the derived interval, aggregated
//                     per spec.aggregation (count(*) for total, count(distinct distinct_id) for
//                     unique/dau); GROUP BY spec.breakdown when present.
//   uniqueCount(spec) SELECT count(distinct distinct_id) over spec.window for the event.
//   rawQuery(expr)    Passes `expr` to the SQL engine AS SQL (this adapter's dialect is SQL,
//                     vs HogQL for the HTTP adapter — the split that justifies `rawQuery`
//                     taking a plain string and naming no dialect).
//
// Every real body normalizes the driver's rows/columns into the neutral `QueryResult` before
// returning, exactly as the HTTP adapter normalizes its wire envelope.

export interface WarehouseQueryAdapterOptions {
  // The injected DB-execute seam — held OPAQUE, exactly as `HttpQueryAdapter` holds its
  // `FetchLike`. Required: the adapter's whole reason to exist is to route SQL through this
  // seam, so there is no "no exec" state. The adapter NEVER sees a DSN or a driver handle;
  // the DSN→driver build lives at the `createWarehouseQueryAdapterFromConfig` boundary.
  dbExecute: DbExecute;
}

export class WarehouseQueryAdapter<TX extends TaxonomyShape>
  implements AnalyticsQueryClient<TX>
{
  private readonly dbExecute: DbExecute;

  constructor(options: WarehouseQueryAdapterOptions) {
    this.dbExecute = options.dbExecute;
  }

  async funnel(spec: FunnelSpec<TX>): Promise<QueryResult<FunnelStepRow>> {
    const { sql, params } = buildFunnelSql(spec);
    const result = await this.dbExecute(sql, params);
    // `event` + the per-group conversionRate base come from the spec, not the flat count rows —
    // the builder is curried on `spec.steps`.
    return assembleResult(result, buildFunnelRows(spec.steps));
  }

  async retention(spec: RetentionSpec<TX>): Promise<QueryResult<RetentionRow>> {
    const { sql, params } = buildRetentionSql(spec);
    const result = await this.dbExecute(sql, params);
    return assembleResult(result, buildRetentionRows);
  }

  async trend(spec: TrendSpec<TX>): Promise<QueryResult<TrendRow>> {
    const { sql, params } = buildTrendSql(spec);
    const result = await this.dbExecute(sql, params);
    return assembleResult(result, buildTrendRows);
  }

  async uniqueCount(spec: UniqueCountSpec<TX>): Promise<QueryResult<UniqueCountRow>> {
    const { sql, params } = buildUniqueCountSql(spec);
    const result = await this.dbExecute(sql, params);
    // `UniqueCountRow` is a type alias of `TrendRow`; the same flat-row builder produces both.
    return assembleResult(result, buildTrendRows);
  }

  async rawQuery(): Promise<QueryResult> {
    throw new Error(NOT_IMPLEMENTED);
  }
}

// Low-level constructor twin of `createHttpQueryAdapter(options)` — takes an already-built
// `DbExecute` and injects it. The DI entry point: a caller (or a test with a fake exec) that
// already holds a `DbExecute` skips DSN parsing entirely.
export function createWarehouseQueryAdapter<TX extends TaxonomyShape>(
  options: WarehouseQueryAdapterOptions
): WarehouseQueryAdapter<TX> {
  return new WarehouseQueryAdapter<TX>(options);
}

// Config-reading twin of `createHttpQueryAdapterFromConfig(config)`. Reads `warehouseDsn`,
// lazily builds the S3 default `DbExecute` from it, and injects it. The lazy optional-`pg`-peer
// load lives INSIDE `createDefaultDbExecute` (deferred to first exec call), so this factory and
// the adapter module import clean without the `warehouse` peer installed. Reached only via
// `createQueryClient`'s warehouse rung, where `warehouseDsn` is known present.
export function createWarehouseQueryAdapterFromConfig<TX extends TaxonomyShape>(config: {
  warehouseDsn: string;
}): WarehouseQueryAdapter<TX> {
  return new WarehouseQueryAdapter<TX>({
    dbExecute: createDefaultDbExecute({ warehouseDsn: config.warehouseDsn }),
  });
}
