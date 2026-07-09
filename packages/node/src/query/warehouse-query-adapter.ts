import type { QueryResult, TaxonomyShape } from 'analytics-kit';
import type { AnalyticsQueryClient } from './query-client';

const NOT_IMPLEMENTED = 'analytics: warehouse query adapter is not yet implemented';

// A second query backend, named by ROLE (never a vendor). It is a TYPED STUB for R1: every
// member satisfies `AnalyticsQueryClient<TX>` and typechecks, but no method computes — each
// throws a neutral not-implemented error. Its reason to exist is the bar-A proof: a second
// adapter satisfies the same neutral interface as `HttpQueryAdapter`, unchanged.
//
// --- Intended per-method SQL mapping (the fill-in seat) ---
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
export class WarehouseQueryAdapter<TX extends TaxonomyShape>
  implements AnalyticsQueryClient<TX>
{
  async funnel(): Promise<QueryResult> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async retention(): Promise<QueryResult> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async trend(): Promise<QueryResult> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async uniqueCount(): Promise<QueryResult> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async rawQuery(): Promise<QueryResult> {
    throw new Error(NOT_IMPLEMENTED);
  }
}

export function createWarehouseQueryAdapter<TX extends TaxonomyShape>(): WarehouseQueryAdapter<TX> {
  return new WarehouseQueryAdapter<TX>();
}
