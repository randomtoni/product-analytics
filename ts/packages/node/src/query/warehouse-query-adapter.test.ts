import type { ShapeOf, TaxonomyShape } from '@randomtoni/analytics-kit';
import { defineTaxonomy } from '@randomtoni/analytics-kit';
import { expect, expectTypeOf, test } from 'vitest';
import type { DbExecuteResult } from './db-execute';
import { createFakeDbExecute } from './db-execute.fixtures';
import type { AnalyticsQueryClient } from './query-client';
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

// S1 fills `trend`/`uniqueCount`; `funnel`/`retention`/`rawQuery` remain S2–S4 fill-in seats and
// still throw the neutral not-implemented error.

test('the still-unimplemented methods reject with the neutral not-implemented error (no vendor leak)', async () => {
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fakeExec() });

  await expect(
    client.funnel({ steps: ['signed_up', 'order_placed'], within: { value: 7, unit: 'day' } })
  ).rejects.toThrow(NOT_IMPLEMENTED);
  await expect(
    client.retention({
      cohortEvent: 'signed_up',
      returnEvent: 'order_placed',
      periods: 4,
      granularity: 'week',
    })
  ).rejects.toThrow(NOT_IMPLEMENTED);
  await expect(client.rawQuery('SELECT 1')).rejects.toThrow(NOT_IMPLEMENTED);
});

test('the not-implemented error message names no vendor', async () => {
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fakeExec() });
  for (const run of [
    () => client.funnel({ steps: ['signed_up'], within: { value: 1, unit: 'day' } }),
    () => client.retention({ cohortEvent: 'signed_up', returnEvent: 'order_placed', periods: 1, granularity: 'day' }),
    () => client.rawQuery('SELECT 1'),
  ]) {
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
