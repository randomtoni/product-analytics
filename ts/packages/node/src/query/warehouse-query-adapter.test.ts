import type { ShapeOf, TaxonomyShape } from '@randomtoni/analytics-kit';
import { defineTaxonomy } from '@randomtoni/analytics-kit';
import { expect, expectTypeOf, test } from 'vitest';
import type { DbExecuteResult } from './db-execute';
import { createFakeDbExecute } from './db-execute.fixtures';
import type { AnalyticsQueryClient, FunnelSpec, RetentionSpec } from './query-client';
import {
  WarehouseQueryAdapter,
  createWarehouseQueryAdapter,
  createWarehouseQueryAdapterFromConfig,
} from './warehouse-query-adapter';

const taxonomy = defineTaxonomy({
  events: { order_placed: { amount: 'number' }, signed_up: {} },
  traits: { plan: 'string' },
});

type TX = ShapeOf<(typeof taxonomy)['decl']>;

const NOT_IMPLEMENTED = 'analytics: warehouse query adapter is not yet implemented';

// A fake DB-execute injected wherever the adapter is constructed — the S3 reusable seam double.
// In S4 the stub methods still throw before ever calling it; it only has to satisfy the required
// `dbExecute` field so the constructor typechecks (E18 will invoke it for real).
const fakeExec = () => createFakeDbExecute().execute;

// The `implements AnalyticsQueryClient<TX>` clause on the class compiles (checked by tsc);
// these assignability assertions pin that a WarehouseQueryAdapter instance IS a valid
// AnalyticsQueryClient — with zero change to the S1 interface (two adapters, one interface).

test('WarehouseQueryAdapter is assignable to AnalyticsQueryClient<TX> (bar-A proof, zero interface change)', () => {
  expectTypeOf<WarehouseQueryAdapter<TX>>().toExtend<AnalyticsQueryClient<TX>>();
  expectTypeOf<WarehouseQueryAdapter<TaxonomyShape>>().toExtend<AnalyticsQueryClient<TaxonomyShape>>();

  const adapter = new WarehouseQueryAdapter<TX>({ dbExecute: fakeExec() });
  const asClient: AnalyticsQueryClient<TX> = adapter;
  expect(asClient).toBe(adapter);
});

test('createWarehouseQueryAdapter returns something satisfying AnalyticsQueryClient<TX>', () => {
  expect(Object.keys(taxonomy.decl.events)).toEqual(['order_placed', 'signed_up']);

  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fakeExec() });
  expect(client).toBeInstanceOf(WarehouseQueryAdapter);
  expect(typeof client.funnel).toBe('function');
  expect(typeof client.retention).toBe('function');
  expect(typeof client.trend).toBe('function');
  expect(typeof client.uniqueCount).toBe('function');
  expect(typeof client.rawQuery).toBe('function');
});

test('the adapter constructor REQUIRES a DbExecute (no bare construction)', () => {
  // The `@ts-expect-error`s prove the field is required at the TYPE level (tsc gate); the
  // expressions are never executed (a bare construction would throw at runtime — the point is
  // that it does not typecheck). `false &&` keeps them unreachable while still type-checked.
  if (false as boolean) {
    // @ts-expect-error the injected `dbExecute` is required — the adapter always holds the seam.
    void new WarehouseQueryAdapter<TX>();
    // @ts-expect-error the low-level factory requires an options object with `dbExecute`.
    void createWarehouseQueryAdapter<TX>();
  }
  expect(true).toBe(true);
});

test('createWarehouseQueryAdapterFromConfig builds the adapter from a warehouseDsn (S3 driver injected)', () => {
  // The config-reading twin of `createHttpQueryAdapterFromConfig`: it reads `warehouseDsn`,
  // lazily builds the S3 default DbExecute from it (the `pg` peer is loaded only on first exec
  // call, never here), and injects it — so this constructs clean with no warehouse peer present.
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapterFromConfig<TX>({
    warehouseDsn: 'postgres://localhost/analytics',
  });
  expect(client).toBeInstanceOf(WarehouseQueryAdapter);
});

test('the adapter never sees a DSN — its only injected field is the opaque DbExecute', () => {
  const dsn = 'postgres://user:secret@localhost/analytics';
  const adapter = createWarehouseQueryAdapterFromConfig<TX>({ warehouseDsn: dsn });
  // The DSN is credential-shaped config read at the factory boundary; it must not be stored
  // on the working adapter. No own-property (or serialized form) carries the DSN.
  expect(JSON.stringify(adapter)).not.toContain('secret');
  for (const value of Object.values(adapter as unknown as Record<string, unknown>)) {
    expect(value).not.toBe(dsn);
    expect(typeof value === 'string' && value.includes('postgres://')).toBe(false);
  }
});

// Called through the AnalyticsQueryClient<TX> interface — the bar-A surface a consumer sees.

// S1 fills `trend`/`uniqueCount`; S2 fills `funnel`; S3 fills `retention`; `rawQuery` remains the
// S4 fill-in seat and still throws the neutral not-implemented error.

test('the still-unimplemented method rejects with the neutral not-implemented error (no vendor leak)', async () => {
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fakeExec() });

  await expect(client.rawQuery('SELECT 1')).rejects.toThrow(NOT_IMPLEMENTED);
});

test('the not-implemented error message names no vendor', async () => {
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fakeExec() });
  for (const run of [() => client.rawQuery('SELECT 1')]) {
    await expect(run()).rejects.toThrow(/^analytics: /);
    await expect(run()).rejects.not.toThrow(/posthog/i);
  }
});

// --- S1: trend + uniqueCount COMPUTE through the injected DbExecute seam --------------------

// A canned `DbExecuteResult` shaped like the warehouse SELECT: bucket/value cells + a driver-
// reported column schema. Single series (no breakdown column).
const trendSingleResult: DbExecuteResult = {
  columns: [
    { name: 'bucket', type: 'text' },
    { name: 'value', type: 'int8' },
  ],
  rows: [
    ['2026-07-01', 12],
    ['2026-07-02', 30],
    ['2026-07-03', 7],
  ],
};

// A breakdown result carries the extra `breakdown` cell per row.
const trendBreakdownResult: DbExecuteResult = {
  columns: [{ name: 'bucket' }, { name: 'value' }, { name: 'breakdown' }],
  rows: [
    ['2026-07-01', 8, 'pro'],
    ['2026-07-02', 20, 'pro'],
    ['2026-07-01', 4, 'free'],
    ['2026-07-02', 10, 'free'],
  ],
};

test('trend routes SQL through the seam and returns flat TrendRows (no throw, no vendor leak)', async () => {
  const fake = createFakeDbExecute(trendSingleResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  const result = await client.trend({
    event: 'order_placed',
    aggregation: 'total',
    window: { value: 30, unit: 'day' },
  });

  expect(result.rows).toEqual([
    { bucket: '2026-07-01', value: 12 },
    { bucket: '2026-07-02', value: 30 },
    { bucket: '2026-07-03', value: 7 },
  ]);
  // The event name is the ONE positional param; the SQL structure is inlined.
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0].params).toEqual(['order_placed']);
});

test('trend SQL buckets via date_trunc, counts with count(*), filters to the event, zero-fills via generate_series', async () => {
  const fake = createFakeDbExecute(trendSingleResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  await client.trend({ event: 'order_placed', aggregation: 'total', window: { value: 30, unit: 'day' } });

  const sql = fake.calls[0].sql;
  expect(sql).toContain("date_trunc('day', timestamp)");
  expect(sql).toContain('count(*)');
  expect(sql).toContain('WHERE event = $1');
  expect(sql).toContain('generate_series');
  expect(sql).toContain('LEFT JOIN counts');
  expect(sql).toContain('coalesce(counts.value, 0)');
  // day granularity → bare ISO date bucket label (no time component).
  expect(sql).toContain("to_char(spine.bucket, 'YYYY-MM-DD')");
  // never the base events table, never raw properties on the counting path.
  expect(sql).toContain('FROM events_typed');
  expect(sql).not.toContain('FROM events ');
});

test('trend unique/dau aggregation uses count(distinct distinct_id)', async () => {
  const fake = createFakeDbExecute(trendSingleResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  await client.trend({ event: 'order_placed', aggregation: 'unique', window: { value: 7, unit: 'day' } });

  expect(fake.calls[0].sql).toContain('count(distinct distinct_id)');
  expect(fake.calls[0].sql).not.toContain('count(*)');
});

test('trend minute/hour window collapses the bucket to hour with a time-carrying label', async () => {
  const fake = createFakeDbExecute(trendSingleResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  await client.trend({ event: 'order_placed', aggregation: 'total', window: { value: 6, unit: 'hour' } });

  const sql = fake.calls[0].sql;
  expect(sql).toContain("date_trunc('hour', timestamp)");
  expect(sql).toContain("to_char(spine.bucket, 'YYYY-MM-DD\"T\"HH24:00:00')");
});

test('trend with a breakdown GROUPs BY the JSONB path and stringifies breakdown onto every row', async () => {
  const fake = createFakeDbExecute(trendBreakdownResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  const result = await client.trend({
    event: 'order_placed',
    aggregation: 'total',
    window: { value: 30, unit: 'day' },
    breakdown: 'plan',
  });

  expect(result.rows).toEqual([
    { bucket: '2026-07-01', value: 8, breakdown: 'pro' },
    { bucket: '2026-07-02', value: 20, breakdown: 'pro' },
    { bucket: '2026-07-01', value: 4, breakdown: 'free' },
    { bucket: '2026-07-02', value: 10, breakdown: 'free' },
  ]);
  const sql = fake.calls[0].sql;
  expect(sql).toContain("properties ->> 'plan'");
  expect(sql).toContain("GROUP BY date_trunc('day', timestamp), properties ->> 'plan'");
  expect(sql).toContain('CROSS JOIN series');
});

test('trend without a breakdown emits no breakdown column and rows omit breakdown', async () => {
  const fake = createFakeDbExecute(trendSingleResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  const result = await client.trend({
    event: 'order_placed',
    aggregation: 'total',
    window: { value: 30, unit: 'day' },
  });

  expect(fake.calls[0].sql).not.toContain('properties ->>');
  for (const row of result.rows) {
    expect(row).not.toHaveProperty('breakdown');
  }
});

test('uniqueCount always counts distinct actors and returns TrendRows', async () => {
  const uniqueResult: DbExecuteResult = {
    columns: [{ name: 'bucket' }, { name: 'value' }],
    rows: [
      ['2026-07-01', 140],
      ['2026-07-02', 165],
    ],
  };
  const fake = createFakeDbExecute(uniqueResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  const result = await client.uniqueCount({ event: 'order_placed', window: { value: 30, unit: 'day' } });

  expect(result.rows).toEqual([
    { bucket: '2026-07-01', value: 140 },
    { bucket: '2026-07-02', value: 165 },
  ]);
  expect(fake.calls[0].sql).toContain('count(distinct distinct_id)');
  expect(fake.calls[0].params).toEqual(['order_placed']);
});

test('the assembler stamps columns from the driver schema, stamps generatedAt, and omits fromCache', async () => {
  const fake = createFakeDbExecute(trendSingleResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  const result = await client.trend({
    event: 'order_placed',
    aggregation: 'total',
    window: { value: 30, unit: 'day' },
  });

  // Unlike the HTTP structured path (forced `columns: []`), the warehouse stamps the driver-
  // reported SELECT schema — the neutral column set, carrying `type` only when present.
  expect(result.columns).toEqual([
    { name: 'bucket', type: 'text' },
    { name: 'value', type: 'int8' },
  ]);
  expect(typeof result.generatedAt).toBe('string');
  expect(new Date(result.generatedAt).toString()).not.toBe('Invalid Date');
  expect(result).not.toHaveProperty('fromCache');
});

test('empty result (no events) yields empty rows, never a throw — the zero-fill degenerate case', async () => {
  const emptyResult: DbExecuteResult = { columns: [{ name: 'bucket' }, { name: 'value' }], rows: [] };
  const fake = createFakeDbExecute(emptyResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  const result = await client.trend({
    event: 'order_placed',
    aggregation: 'total',
    window: { value: 30, unit: 'day' },
  });

  expect(result.rows).toEqual([]);
  expect(result.columns).toEqual([{ name: 'bucket' }, { name: 'value' }]);
});

test('no SQL column name or engine token leaks onto a returned row', async () => {
  const fake = createFakeDbExecute(trendBreakdownResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  const result = await client.trend({
    event: 'order_placed',
    aggregation: 'total',
    window: { value: 30, unit: 'day' },
    breakdown: 'plan',
  });

  for (const row of result.rows) {
    expect(new Set(Object.keys(row))).toEqual(new Set(['bucket', 'value', 'breakdown']));
  }
});

// The exact canonical SQL string for one trend case. This literal is MIRRORED byte-for-byte in the
// Python warehouse adapter test (`test_the_generated_trend_sql_matches_the_canonical_cross_tree_string`)
// — the two assertions together pin cross-tree SQL parity: the Postgres string is language-agnostic,
// so any divergence between the trees trips one of the two mirrored literals.
const CANONICAL_TREND_SQL = [
  'WITH counts AS (',
  "  SELECT date_trunc('day', timestamp) AS bucket, count(*) AS value",
  '  FROM events_typed',
  "  WHERE event = $1 AND timestamp >= date_trunc('day', now() - interval '30 day')",
  "  GROUP BY date_trunc('day', timestamp)",
  ')',
  "SELECT to_char(spine.bucket, 'YYYY-MM-DD') AS bucket, coalesce(counts.value, 0) AS value",
  "FROM generate_series(date_trunc('day', now() - interval '30 day'), date_trunc('day', now()), interval '1 day') AS spine(bucket)",
  '  LEFT JOIN counts ON counts.bucket = spine.bucket',
  'ORDER BY spine.bucket',
].join('\n');

test('the generated trend SQL matches the canonical cross-tree string (byte-identical to Python)', async () => {
  const fake = createFakeDbExecute(trendSingleResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  await client.trend({ event: 'order_placed', aggregation: 'total', window: { value: 30, unit: 'day' } });

  expect(fake.calls[0].sql).toBe(CANONICAL_TREND_SQL);
});

test('a breakdown key with an embedded single quote is SQL-escaped in the JSONB path (injection-safe)', async () => {
  const fake = createFakeDbExecute(trendSingleResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  await client.trend({
    event: 'order_placed',
    aggregation: 'total',
    window: { value: 30, unit: 'day' },
    breakdown: "o'brien",
  });

  // The single quote is doubled per the SQL standard — the same escaping the view generator uses.
  expect(fake.calls[0].sql).toContain("properties ->> 'o''brien'");
});

// --- S2: funnel COMPUTES through the injected DbExecute seam ---------------------------------

// The funnel SQL returns N rows (one per step): `(step_index, event_name, actor_count)`. Each
// adversarial scenario is driven by handing the fake the step-count rows THAT scenario's SQL
// would return — the SQL's ordering/window/boundary logic is what produces those counts; the
// adapter + flat-row builder are what this suite exercises directly (SQL shape is asserted
// separately). The two-step signed_up → order_placed funnel is the running example.

const twoStepFunnelSpec: FunnelSpec<TX> = {
  steps: ['signed_up', 'order_placed'],
  within: { value: 7, unit: 'day' },
};

// A many-event taxonomy shape for the multi-step funnel cases (the shared S1 taxonomy is two-event
// and its key set is pinned by an S1 assertion, so it is not widened here). Only the type is
// needed — no runtime taxonomy value — so it is expressed as a `ShapeOf` over a literal decl.
type TX3 = ShapeOf<{
  events: {
    signed_up: Record<string, never>;
    order_placed: { amount: 'number' };
    document_uploaded: Record<string, never>;
    a: Record<string, never>;
    b: Record<string, never>;
    c: Record<string, never>;
  };
}>;

// step-0 count 1000, step-1 count 620 → conversionRate 1, 0.62 (matches funnelPlain contract).
const funnelPlainResult: DbExecuteResult = {
  columns: [
    { name: 'step_index', type: 'int4' },
    { name: 'event_name', type: 'text' },
    { name: 'actor_count', type: 'int8' },
  ],
  rows: [
    [0, 'signed_up', 1000],
    [1, 'order_placed', 620],
  ],
};

test('funnel COMPUTES: routes SQL through the seam, returns FunnelStepRows with spec-sourced event + computed conversionRate', async () => {
  const fake = createFakeDbExecute(funnelPlainResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  const result = await client.funnel(twoStepFunnelSpec);

  expect(result.rows).toEqual([
    { step: 0, event: 'signed_up', count: 1000, conversionRate: 1 },
    { step: 1, event: 'order_placed', count: 620, conversionRate: 0.62 },
  ]);
  // Each step's event name is a positional param, in step order.
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0].params).toEqual(['signed_up', 'order_placed']);
});

test('funnel makes ONE DbExecute call with a SINGLE statement (not query-per-step)', async () => {
  const fake = createFakeDbExecute(funnelPlainResult);
  const client: AnalyticsQueryClient<TX3> = createWarehouseQueryAdapter<TX3>({ dbExecute: fake.execute });

  await client.funnel({ steps: ['signed_up', 'order_placed', 'document_uploaded'], within: { value: 7, unit: 'day' } });

  expect(fake.calls).toHaveLength(1);
  // A single statement — no semicolon-joined batch of per-step queries.
  expect(fake.calls[0].sql.split(';').filter((s) => s.trim().length > 0)).toHaveLength(1);
});

test('funnel SQL: per-actor ordered walk anchored at t0, strict ordering, INCLUSIVE window, distinct-actor counts', async () => {
  const fake = createFakeDbExecute(funnelPlainResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  await client.funnel(twoStepFunnelSpec);

  const sql = fake.calls[0].sql;
  // t0 anchored at the step-0 event's earliest timestamp per actor.
  expect(sql).toContain('min(timestamp) AS t0');
  expect(sql).toContain('FROM matched WHERE step_index = 0');
  // Strict step-to-step ordering: the next step must be STRICTLY after the prior reached_at.
  expect(sql).toContain('m.timestamp > w.reached_at');
  // Window measured from step 0 and INCLUSIVE upper bound (closed [t0, t0 + within], `<=`).
  expect(sql).toContain("m.timestamp <= w.t0 + interval '7 day'");
  // Distinct-actor counts (the S1 review's positive-assertion note: assert the intended shape,
  // NOT a `not.toContain('count(*)')` negative — funnel legitimately uses count(distinct …)).
  expect(sql).toContain('count(DISTINCT w.distinct_id) AS actor_count');
  // Single recursive statement over the typed view, never the base events table.
  expect(sql).toContain('WITH RECURSIVE');
  expect(sql).toContain('FROM events_typed e');
  expect(sql).not.toContain('FROM events ');
  // Steps bound as positional params (never inlined event literals).
  expect(sql).toContain('VALUES (0, $1), (1, $2)');
});

test('funnel SQL is structurally constant across step count (only VALUES rows + recursion bound vary)', async () => {
  const fake = createFakeDbExecute(funnelPlainResult);
  const client: AnalyticsQueryClient<TX3> = createWarehouseQueryAdapter<TX3>({ dbExecute: fake.execute });

  await client.funnel({ steps: ['a', 'b'], within: { value: 7, unit: 'day' } });
  await client.funnel({ steps: ['a', 'b', 'c'], within: { value: 7, unit: 'day' } });

  const twoStep = fake.calls[0].sql;
  const threeStep = fake.calls[1].sql;
  // The step count only shifts the VALUES rows and the `< N` recursion bound; the CTE body is
  // otherwise byte-identical between arities.
  expect(twoStep).toContain('VALUES (0, $1), (1, $2)');
  expect(twoStep).toContain('WHERE w.step_index + 1 < 2');
  expect(threeStep).toContain('VALUES (0, $1), (1, $2), (2, $3)');
  expect(threeStep).toContain('WHERE w.step_index + 1 < 3');
  // The recursive-term chase line is identical regardless of arity.
  expect(twoStep).toContain('    (SELECT min(m.timestamp) FROM matched m');
  expect(threeStep).toContain('    (SELECT min(m.timestamp) FROM matched m');
});

// ADVERSARIAL — out-of-order: an actor firing step 2's event before step 1's does NOT complete
// the funnel. The SQL's `m.timestamp > w.reached_at` strict clause excludes them from step 1's
// reach; the fake returns the counts that SQL would produce (step-1 count reflects only in-order
// actors). Here 1000 reached step 0, only 400 completed step 1 in order — the out-of-order actor
// is NOT among the 400.
test('funnel ADVERSARIAL out-of-order: step-2-before-step-1 does not count toward the funnel (strict ordering)', async () => {
  const outOfOrderResult: DbExecuteResult = {
    columns: [{ name: 'step_index' }, { name: 'event_name' }, { name: 'actor_count' }],
    rows: [
      [0, 'signed_up', 1000],
      [1, 'order_placed', 400],
    ],
  };
  const fake = createFakeDbExecute(outOfOrderResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  const result = await client.funnel(twoStepFunnelSpec);

  expect(result.rows).toEqual([
    { step: 0, event: 'signed_up', count: 1000, conversionRate: 1 },
    { step: 1, event: 'order_placed', count: 400, conversionRate: 0.4 },
  ]);
  // The strict-ordering predicate is present in the emitted SQL (what excludes the out-of-order actor).
  expect(fake.calls[0].sql).toContain('m.timestamp > w.reached_at');
});

// ADVERSARIAL — boundary INCLUSIVE: completion exactly at t0 + within COUNTS; one tick past does
// NOT. The `<=` predicate is what includes the boundary actor. The two canned results model the
// two SQL outcomes: at-boundary → the actor is counted (step-1 count includes them); one-tick-past
// → excluded (step-1 count is one lower).
test('funnel ADVERSARIAL boundary: completion exactly at t0 + within COUNTS (inclusive `<=` upper bound)', async () => {
  const atBoundaryResult: DbExecuteResult = {
    columns: [{ name: 'step_index' }, { name: 'event_name' }, { name: 'actor_count' }],
    rows: [
      [0, 'signed_up', 10],
      [1, 'order_placed', 10],
    ],
  };
  const fake = createFakeDbExecute(atBoundaryResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  const result = await client.funnel(twoStepFunnelSpec);

  expect(result.rows[1]).toEqual({ step: 1, event: 'order_placed', count: 10, conversionRate: 1 });
  // The upper bound is the closed interval `<=` (INCLUSIVE), not `<`.
  expect(fake.calls[0].sql).toContain("m.timestamp <= w.t0 + interval '7 day'");
  expect(fake.calls[0].sql).not.toContain("m.timestamp < w.t0 + interval '7 day'");
});

test('funnel ADVERSARIAL boundary: completion one tick past t0 + within does NOT count', async () => {
  const oneTickPastResult: DbExecuteResult = {
    columns: [{ name: 'step_index' }, { name: 'event_name' }, { name: 'actor_count' }],
    rows: [
      [0, 'signed_up', 10],
      [1, 'order_placed', 9],
    ],
  };
  const fake = createFakeDbExecute(oneTickPastResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  const result = await client.funnel(twoStepFunnelSpec);

  // The one actor whose step 1 landed a tick past the window is excluded: 9, not 10.
  expect(result.rows[1]).toEqual({ step: 1, event: 'order_placed', count: 9, conversionRate: 0.9 });
});

// ADVERSARIAL — partial completion: an actor reaching step 1 but not step 2 counts toward step 1,
// not step 2; per-step counts are monotonically non-increasing.
test('funnel ADVERSARIAL partial completion: reaching step 1 not step 2 counts toward step 1; counts non-increasing', async () => {
  const partialResult: DbExecuteResult = {
    columns: [{ name: 'step_index' }, { name: 'event_name' }, { name: 'actor_count' }],
    rows: [
      [0, 'signed_up', 1000],
      [1, 'order_placed', 620],
      [2, 'document_uploaded', 410],
    ],
  };
  const fake = createFakeDbExecute(partialResult);
  const client: AnalyticsQueryClient<TX3> = createWarehouseQueryAdapter<TX3>({ dbExecute: fake.execute });

  const result = await client.funnel({
    steps: ['signed_up', 'order_placed', 'document_uploaded'],
    within: { value: 7, unit: 'day' },
  });

  expect(result.rows).toEqual([
    { step: 0, event: 'signed_up', count: 1000, conversionRate: 1 },
    { step: 1, event: 'order_placed', count: 620, conversionRate: 0.62 },
    { step: 2, event: 'document_uploaded', count: 410, conversionRate: 0.41 },
  ]);
  // Per-step monotonic non-increase holds (an actor who dropped at step 1 is NOT in step 2's count).
  const counts = result.rows.map((r) => r.count);
  for (let i = 1; i < counts.length; i++) {
    expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
  }
});

// ADVERSARIAL — conversionRate guard: count[0] === 0 ⇒ conversionRate 0 on EVERY step (no
// NaN/Infinity leak). Mirrors the HTTP `funnelZeroFirstStep` fixture exactly.
test('funnel conversionRate guard: count[0] === 0 ⇒ conversionRate 0 on every step', async () => {
  const zeroFirstResult: DbExecuteResult = {
    columns: [{ name: 'step_index' }, { name: 'event_name' }, { name: 'actor_count' }],
    rows: [
      [0, 'signed_up', 0],
      [1, 'order_placed', 0],
    ],
  };
  const fake = createFakeDbExecute(zeroFirstResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  const result = await client.funnel(twoStepFunnelSpec);

  expect(result.rows).toEqual([
    { step: 0, event: 'signed_up', count: 0, conversionRate: 0 },
    { step: 1, event: 'order_placed', count: 0, conversionRate: 0 },
  ]);
  // No NaN/Infinity leaked through the guard.
  for (const row of result.rows) {
    expect(Number.isFinite(row.conversionRate)).toBe(true);
  }
});

test('funnel conversionRate: normal ratios are count[step] / count[0]', async () => {
  const fake = createFakeDbExecute(funnelPlainResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  const result = await client.funnel(twoStepFunnelSpec);

  expect(result.rows[0].conversionRate).toBe(1);
  expect(result.rows[1].conversionRate).toBeCloseTo(0.62, 10);
});

// With a breakdown: SQL groups per breakdown value, conversionRate is PER-GROUP, and the breakdown
// is stringified onto every row. Each group's step-0 count is that group's base.
test('funnel with a breakdown: per-group conversionRate, breakdown on every row, JSONB-path GROUP BY', async () => {
  const breakdownResult: DbExecuteResult = {
    columns: [
      { name: 'step_index' },
      { name: 'event_name' },
      { name: 'breakdown' },
      { name: 'actor_count' },
    ],
    rows: [
      [0, 'signed_up', 'pro', 800],
      [1, 'order_placed', 'pro', 400],
      [0, 'signed_up', 'free', 200],
      [1, 'order_placed', 'free', 50],
    ],
  };
  const fake = createFakeDbExecute(breakdownResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  const result = await client.funnel({ ...twoStepFunnelSpec, breakdown: 'plan' });

  expect(result.rows).toEqual([
    { step: 0, event: 'signed_up', count: 800, conversionRate: 1, breakdown: 'pro' },
    { step: 1, event: 'order_placed', count: 400, conversionRate: 0.5, breakdown: 'pro' },
    { step: 0, event: 'signed_up', count: 200, conversionRate: 1, breakdown: 'free' },
    { step: 1, event: 'order_placed', count: 50, conversionRate: 0.25, breakdown: 'free' },
  ]);
  const sql = fake.calls[0].sql;
  expect(sql).toContain("properties ->> 'plan' AS bd");
  expect(sql).toContain('GROUP BY s.step_index, s.event_name, w.bd');
  // The breakdown value is anchored at each actor's step-0 event (one bucket per actor).
  expect(sql).toContain('(array_agg(bd ORDER BY timestamp))[1] AS bd');
});

test('funnel rows carry no engine wire field (no average_conversion_time / converted_people_url / breakdown_value)', async () => {
  const fake = createFakeDbExecute(funnelPlainResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  const result = await client.funnel(twoStepFunnelSpec);

  for (const row of result.rows) {
    const keys = new Set(Object.keys(row));
    expect(keys).toEqual(new Set(['step', 'event', 'count', 'conversionRate']));
    for (const engineField of ['average_conversion_time', 'converted_people_url', 'breakdown_value']) {
      expect(row).not.toHaveProperty(engineField);
    }
  }
});

// The exact canonical funnel SQL string for the plain two-step case. MIRRORED byte-for-byte in the
// Python warehouse adapter test — the two assertions together pin cross-tree funnel SQL parity.
const CANONICAL_FUNNEL_SQL = [
  'WITH RECURSIVE steps(step_index, event_name) AS (',
  '  VALUES (0, $1), (1, $2)',
  '),',
  'matched AS (',
  '  SELECT e.distinct_id, s.step_index, e.timestamp',
  '  FROM events_typed e',
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
  "      WHERE m.distinct_id = w.distinct_id AND m.step_index = w.step_index + 1 AND m.timestamp > w.reached_at AND m.timestamp <= w.t0 + interval '7 day'),",
  '    w.t0',
  '  FROM walk w',
  '  WHERE w.step_index + 1 < 2',
  '    AND EXISTS (SELECT 1 FROM matched m',
  "      WHERE m.distinct_id = w.distinct_id AND m.step_index = w.step_index + 1 AND m.timestamp > w.reached_at AND m.timestamp <= w.t0 + interval '7 day')",
  ')',
  'SELECT s.step_index, s.event_name, count(DISTINCT w.distinct_id) AS actor_count',
  'FROM steps s',
  '  LEFT JOIN walk w ON w.step_index = s.step_index AND w.reached_at IS NOT NULL',
  'GROUP BY s.step_index, s.event_name',
  'ORDER BY s.step_index',
].join('\n');

test('the generated funnel SQL matches the canonical cross-tree string (byte-identical to Python)', async () => {
  const fake = createFakeDbExecute(funnelPlainResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  await client.funnel(twoStepFunnelSpec);

  expect(fake.calls[0].sql).toBe(CANONICAL_FUNNEL_SQL);
});

// --- S3: retention COMPUTES through the injected DbExecute seam ------------------------------

// The retention SQL returns one row per DENSE (cohort, period_index) cell:
// `(cohort, period_index, value[, breakdown])`. Each adversarial scenario is driven by handing the
// fake the grid rows THAT scenario's SQL would return — the SQL's cohort self-join / bounded-grid /
// per-cohort-distinct-count logic is what produces those cells; the adapter + flat-row builder are
// what this suite exercises directly (SQL shape is asserted separately). The running example is a
// signed_up → order_placed retention over 3 weekly periods. `period_index=0` is the cohort's OWN
// period throughout (the base cohort size measured via the RETURN event in the cohort's own bucket).

const retentionSpec: RetentionSpec<TX> = {
  cohortEvent: 'signed_up',
  returnEvent: 'order_placed',
  periods: 3,
  granularity: 'week',
};

// A canned grid: two cohort buckets × 3 periods. period 0 is each cohort's own base (500, 420),
// decaying across subsequent periods — matching the retentionCohorts contract fixture exactly.
const retentionGridResult: DbExecuteResult = {
  columns: [
    { name: 'cohort', type: 'text' },
    { name: 'period_index', type: 'int4' },
    { name: 'value', type: 'int8' },
  ],
  rows: [
    ['2026-07-01', 0, 500],
    ['2026-07-01', 1, 310],
    ['2026-07-01', 2, 190],
    ['2026-07-08', 0, 420],
    ['2026-07-08', 1, 250],
    ['2026-07-08', 2, 150],
  ],
};

test('retention COMPUTES: routes SQL through the seam, returns flat RetentionRows (one per cell)', async () => {
  const fake = createFakeDbExecute(retentionGridResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  const result = await client.retention(retentionSpec);

  expect(result.rows).toEqual([
    { cohort: '2026-07-01', periodIndex: 0, value: 500 },
    { cohort: '2026-07-01', periodIndex: 1, value: 310 },
    { cohort: '2026-07-01', periodIndex: 2, value: 190 },
    { cohort: '2026-07-08', periodIndex: 0, value: 420 },
    { cohort: '2026-07-08', periodIndex: 1, value: 250 },
    { cohort: '2026-07-08', periodIndex: 2, value: 150 },
  ]);
  // cohortEvent + returnEvent are the two positional params, in that order.
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0].params).toEqual(['signed_up', 'order_placed']);
});

test('retention makes ONE DbExecute call with a SINGLE statement (dense grid, not query-per-cohort/period)', async () => {
  const fake = createFakeDbExecute(retentionGridResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  await client.retention(retentionSpec);

  expect(fake.calls).toHaveLength(1);
  // A single statement — no semicolon-joined batch of per-cohort or per-period queries.
  expect(fake.calls[0].sql.split(';').filter((s) => s.trim().length > 0)).toHaveLength(1);
});

test('retention SQL: cohort self-join, granularity bucketing, dense generate_series grid, per-cohort distinct count', async () => {
  const fake = createFakeDbExecute(retentionGridResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  await client.retention(retentionSpec);

  const sql = fake.calls[0].sql;
  // Cohort = actors who did the cohort event ($1), bucketed by granularity.
  expect(sql).toContain("date_trunc('week', timestamp) AS cohort_bucket");
  expect(sql).toContain('WHERE event = $1');
  // Return rows = the return event ($2), same granularity bucketing.
  expect(sql).toContain("date_trunc('week', timestamp) AS return_bucket");
  expect(sql).toContain('WHERE event = $2');
  // DENSE grid: generate_series over 0..periods-1 CROSS JOINed against distinct cohort buckets.
  expect(sql).toContain('generate_series(0, 2)');
  expect(sql).toContain('CROSS JOIN generate_series(0, 2) AS p(period_index)');
  expect(sql).toContain('SELECT DISTINCT cohort_bucket FROM cohort');
  // period_index=0 is the cohort's OWN bucket: the return bucket is cohort_bucket + offset*interval,
  // so offset 0 targets the cohort's own bucket (not the first subsequent bucket).
  expect(sql).toContain("g.cohort_bucket + (g.period_index * interval '1 week')");
  // Per-cohort distinct-actor count (positive assertion — retention legitimately uses distinct).
  expect(sql).toContain('count(DISTINCT c.distinct_id) AS value');
  // Dense LEFT JOIN so an empty cell surfaces as 0, never a gap.
  expect(sql).toContain('LEFT JOIN cells');
  expect(sql).toContain('coalesce(cells.value, 0) AS value');
  // day/week/month → bare ISO date cohort label.
  expect(sql).toContain("to_char(g.cohort_bucket, 'YYYY-MM-DD') AS cohort");
  // Over the typed view, never the base events table.
  expect(sql).toContain('FROM events_typed');
  expect(sql).not.toContain('FROM events ');
});

// ADVERSARIAL — period_index=0 is the cohort's OWN period (the most common off-by-one). The p0 cell
// is the cohort base measured via the return event in the cohort's own bucket, NOT the first
// SUBSEQUENT period. Asserted explicitly against the base values.
test('retention ADVERSARIAL period_index=0 is the cohort base (its own period), not the first return period', async () => {
  const fake = createFakeDbExecute(retentionGridResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  const result = await client.retention(retentionSpec);

  // p0 is the cohort's own-bucket base (500 / 420) — the largest cell of each cohort; p1/p2 decay.
  const cohort1 = result.rows.filter((r) => r.cohort === '2026-07-01');
  expect(cohort1[0]).toEqual({ cohort: '2026-07-01', periodIndex: 0, value: 500 });
  expect(cohort1[0].value).toBeGreaterThan(cohort1[1].value);
  expect(cohort1[1].value).toBeGreaterThan(cohort1[2].value);
  // The offset arithmetic makes p0 target the cohort's OWN bucket (offset 0), not the next bucket.
  expect(fake.calls[0].sql).toContain("g.cohort_bucket + (g.period_index * interval '1 week')");
});

// ADVERSARIAL — actor in multiple cohorts: an actor doing the cohort event in two buckets is a
// member of BOTH cohorts; the per-cell distinct-count is per-cohort, not global. The grid the SQL
// returns reflects that: the same actor is counted once in each cohort's cells. Here the two
// cohorts' p0 bases OVERLAP on one shared actor, yet each cohort's p0 counts that actor
// independently (500 and 420 respectively) — a global distinct-count would have deduped across.
test('retention ADVERSARIAL actor in multiple cohorts: counted per-cohort, not globally deduped', async () => {
  // Two cohorts whose base counts include the same recurring actor; the per-cohort counts stand
  // independently (the SQL groups by cohort_bucket, so a multi-cohort actor participates in each).
  const multiCohortResult: DbExecuteResult = {
    columns: [{ name: 'cohort' }, { name: 'period_index' }, { name: 'value' }],
    rows: [
      ['2026-07-01', 0, 500],
      ['2026-07-01', 1, 310],
      ['2026-07-01', 2, 190],
      ['2026-07-08', 0, 420],
      ['2026-07-08', 1, 250],
      ['2026-07-08', 2, 150],
    ],
  };
  const fake = createFakeDbExecute(multiCohortResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  const result = await client.retention(retentionSpec);

  // Both cohorts' bases are present and counted independently — no cross-cohort dedup.
  const c1p0 = result.rows.find((r) => r.cohort === '2026-07-01' && r.periodIndex === 0);
  const c2p0 = result.rows.find((r) => r.cohort === '2026-07-08' && r.periodIndex === 0);
  expect(c1p0).toEqual({ cohort: '2026-07-01', periodIndex: 0, value: 500 });
  expect(c2p0).toEqual({ cohort: '2026-07-08', periodIndex: 0, value: 420 });
  // The distinct-count is GROUPED per cohort_bucket (per-cohort), never a single global count.
  expect(fake.calls[0].sql).toContain('GROUP BY g.cohort_bucket, g.period_index');
  expect(fake.calls[0].sql).toContain('count(DISTINCT c.distinct_id)');
});

// ADVERSARIAL — return outside the periods window: a return event past `periods` buckets lands on
// no grid cell (the grid is bounded to 0..periods-1) and contributes to nothing. The SQL the fake
// stands in for would join returns only where return_bucket = cohort_bucket + offset for offset in
// 0..periods-1, so an out-of-window return never appears. The returned grid has exactly
// cohorts × periods rows (6), with the out-of-window activity NOT inflating any cell.
test('retention ADVERSARIAL return outside the periods window contributes to no cell (bounded grid)', async () => {
  // A cohort whose members returned in period 2 AND far outside the window; only the in-window
  // return is reflected. The grid still has exactly periods (3) cells for the single cohort.
  const boundedResult: DbExecuteResult = {
    columns: [{ name: 'cohort' }, { name: 'period_index' }, { name: 'value' }],
    rows: [
      ['2026-07-01', 0, 100],
      ['2026-07-01', 1, 40],
      ['2026-07-01', 2, 12],
    ],
  };
  const fake = createFakeDbExecute(boundedResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  const result = await client.retention(retentionSpec);

  // Exactly `periods` cells for the single cohort — no period_index >= 3 leaks in from an
  // out-of-window return.
  expect(result.rows).toHaveLength(3);
  expect(result.rows.every((r) => r.periodIndex < 3)).toBe(true);
  // The grid is bounded by generate_series(0, periods-1); nothing past it is generated.
  expect(fake.calls[0].sql).toContain('generate_series(0, 2)');
});

// ADVERSARIAL — no-return actor: a cohort member who never returns is counted in period 0 (the
// base, via the return event in the cohort's own bucket) but decays to 0 in later periods. The
// dense LEFT JOIN emits those later cells as value 0 rather than dropping them.
test('retention ADVERSARIAL no-return actor: counted in period 0, decays to 0 in later periods (dense)', async () => {
  const noReturnResult: DbExecuteResult = {
    columns: [{ name: 'cohort' }, { name: 'period_index' }, { name: 'value' }],
    rows: [
      ['2026-07-01', 0, 80],
      ['2026-07-01', 1, 0],
      ['2026-07-01', 2, 0],
    ],
  };
  const fake = createFakeDbExecute(noReturnResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  const result = await client.retention(retentionSpec);

  expect(result.rows).toEqual([
    { cohort: '2026-07-01', periodIndex: 0, value: 80 },
    { cohort: '2026-07-01', periodIndex: 1, value: 0 },
    { cohort: '2026-07-01', periodIndex: 2, value: 0 },
  ]);
  // The decayed cells are PRESENT rows with value 0 (dense), not omitted — coalesce fills them.
  expect(fake.calls[0].sql).toContain('coalesce(cells.value, 0)');
});

// ADVERSARIAL — empty/sparse cohort: a cohort with a zero cell still emits a row with value 0. The
// grid is dense over 0..periods-1 so there are NO gaps — a missing count becomes a present 0 cell.
test('retention ADVERSARIAL sparse cohort: a zero cell still emits a row with value 0 (no gaps)', async () => {
  // A sparse cohort: it has a base (p0) and a p2 blip but a completely empty p1. The dense grid
  // fills p1 with 0 rather than skipping it — the row count stays cohorts × periods.
  const sparseResult: DbExecuteResult = {
    columns: [{ name: 'cohort' }, { name: 'period_index' }, { name: 'value' }],
    rows: [
      ['2026-07-01', 0, 60],
      ['2026-07-01', 1, 0],
      ['2026-07-01', 2, 5],
    ],
  };
  const fake = createFakeDbExecute(sparseResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  const result = await client.retention(retentionSpec);

  // Every period is present — the p1 gap is a value-0 row, not a missing row.
  expect(result.rows).toHaveLength(3);
  expect(result.rows.map((r) => r.periodIndex)).toEqual([0, 1, 2]);
  expect(result.rows.find((r) => r.periodIndex === 1)).toEqual({
    cohort: '2026-07-01',
    periodIndex: 1,
    value: 0,
  });
});

test('retention with a breakdown: one grid per breakdown value, breakdown stringified onto every row, JSONB GROUP BY', async () => {
  const breakdownResult: DbExecuteResult = {
    columns: [
      { name: 'cohort' },
      { name: 'period_index' },
      { name: 'value' },
      { name: 'breakdown' },
    ],
    rows: [
      ['2026-07-01', 0, 300, 'pro'],
      ['2026-07-01', 1, 180, 'pro'],
      ['2026-07-01', 0, 200, 'free'],
      ['2026-07-01', 1, 60, 'free'],
    ],
  };
  const fake = createFakeDbExecute(breakdownResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  const result = await client.retention({ ...retentionSpec, periods: 2, breakdown: 'plan' });

  expect(result.rows).toEqual([
    { cohort: '2026-07-01', periodIndex: 0, value: 300, breakdown: 'pro' },
    { cohort: '2026-07-01', periodIndex: 1, value: 180, breakdown: 'pro' },
    { cohort: '2026-07-01', periodIndex: 0, value: 200, breakdown: 'free' },
    { cohort: '2026-07-01', periodIndex: 1, value: 60, breakdown: 'free' },
  ]);
  const sql = fake.calls[0].sql;
  expect(sql).toContain("properties ->> 'plan' AS bd");
  expect(sql).toContain('GROUP BY g.cohort_bucket, g.bd, g.period_index');
  // One grid per breakdown value: buckets carry the breakdown, the grid cross-joins it.
  expect(sql).toContain('SELECT DISTINCT cohort_bucket, bd FROM cohort');
});

test('retention without a breakdown emits no breakdown path and rows omit breakdown', async () => {
  const fake = createFakeDbExecute(retentionGridResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  const result = await client.retention(retentionSpec);

  expect(fake.calls[0].sql).not.toContain('properties ->>');
  for (const row of result.rows) {
    expect(row).not.toHaveProperty('breakdown');
  }
});

test('retention rows match RetentionRow exactly — no engine wire field (breakdown_value) leaks', async () => {
  const fake = createFakeDbExecute(retentionGridResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  const result = await client.retention(retentionSpec);

  for (const row of result.rows) {
    expect(new Set(Object.keys(row))).toEqual(new Set(['cohort', 'periodIndex', 'value']));
    expect(row).not.toHaveProperty('breakdown_value');
  }
});

test('retention breakdown key with an embedded single quote is SQL-escaped in the JSONB path (injection-safe)', async () => {
  const fake = createFakeDbExecute(retentionGridResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  await client.retention({ ...retentionSpec, breakdown: "o'brien" });

  expect(fake.calls[0].sql).toContain("properties ->> 'o''brien'");
});

test('retention day/month granularity swaps the truncation + offset interval unit', async () => {
  const fake = createFakeDbExecute(retentionGridResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  await client.retention({ ...retentionSpec, granularity: 'day' });
  await client.retention({ ...retentionSpec, granularity: 'month' });

  const daySql = fake.calls[0].sql;
  const monthSql = fake.calls[1].sql;
  expect(daySql).toContain("date_trunc('day', timestamp) AS cohort_bucket");
  expect(daySql).toContain("g.cohort_bucket + (g.period_index * interval '1 day')");
  expect(monthSql).toContain("date_trunc('month', timestamp) AS cohort_bucket");
  expect(monthSql).toContain("g.cohort_bucket + (g.period_index * interval '1 month')");
});

// The exact canonical retention SQL string for the plain 3-period weekly case. MIRRORED
// byte-for-byte in the Python warehouse adapter test — the two assertions together pin cross-tree
// retention SQL parity (the Postgres string is language-agnostic).
const CANONICAL_RETENTION_SQL = [
  'WITH cohort AS (',
  "  SELECT distinct_id, date_trunc('week', timestamp) AS cohort_bucket",
  '  FROM events_typed',
  '  WHERE event = $1',
  "  GROUP BY distinct_id, date_trunc('week', timestamp)",
  '),',
  'returns AS (',
  "  SELECT distinct_id, date_trunc('week', timestamp) AS return_bucket",
  '  FROM events_typed',
  '  WHERE event = $2',
  "  GROUP BY distinct_id, date_trunc('week', timestamp)",
  '),',
  'buckets AS (SELECT DISTINCT cohort_bucket FROM cohort),',
  'grid AS (',
  '  SELECT b.cohort_bucket, p.period_index',
  '  FROM buckets b',
  '  CROSS JOIN generate_series(0, 2) AS p(period_index)',
  '),',
  'cells AS (',
  '  SELECT g.cohort_bucket, g.period_index, count(DISTINCT c.distinct_id) AS value',
  '  FROM grid g',
  '  JOIN cohort c ON c.cohort_bucket = g.cohort_bucket',
  "  JOIN returns r ON r.distinct_id = c.distinct_id AND r.return_bucket = g.cohort_bucket + (g.period_index * interval '1 week')",
  '  GROUP BY g.cohort_bucket, g.period_index',
  ')',
  "SELECT to_char(g.cohort_bucket, 'YYYY-MM-DD') AS cohort, g.period_index AS period_index, coalesce(cells.value, 0) AS value",
  'FROM grid g',
  '  LEFT JOIN cells ON cells.cohort_bucket = g.cohort_bucket AND cells.period_index = g.period_index',
  'ORDER BY g.cohort_bucket, g.period_index',
].join('\n');

test('the generated retention SQL matches the canonical cross-tree string (byte-identical to Python)', async () => {
  const fake = createFakeDbExecute(retentionGridResult);
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute });

  await client.retention(retentionSpec);

  expect(fake.calls[0].sql).toBe(CANONICAL_RETENTION_SQL);
});
