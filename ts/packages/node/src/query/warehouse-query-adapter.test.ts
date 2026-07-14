import type { ShapeOf, TaxonomyShape } from '@randomtoni/analytics-kit';
import { defineTaxonomy } from '@randomtoni/analytics-kit';
import { expect, expectTypeOf, test } from 'vitest';
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

test('every method rejects with the neutral not-implemented error (no vendor leak, never computes)', async () => {
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
  await expect(
    client.trend({ event: 'order_placed', aggregation: 'total', window: { value: 30, unit: 'day' } })
  ).rejects.toThrow(NOT_IMPLEMENTED);
  await expect(
    client.uniqueCount({ event: 'order_placed', window: { value: 1, unit: 'month' } })
  ).rejects.toThrow(NOT_IMPLEMENTED);
  await expect(client.rawQuery('SELECT 1')).rejects.toThrow(NOT_IMPLEMENTED);
});

test('the not-implemented error message names no vendor', async () => {
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>({ dbExecute: fakeExec() });
  for (const run of [
    () => client.funnel({ steps: ['signed_up'], within: { value: 1, unit: 'day' } }),
    () => client.retention({ cohortEvent: 'signed_up', returnEvent: 'order_placed', periods: 1, granularity: 'day' }),
    () => client.trend({ event: 'order_placed', aggregation: 'total', window: { value: 1, unit: 'day' } }),
    () => client.uniqueCount({ event: 'order_placed', window: { value: 1, unit: 'day' } }),
    () => client.rawQuery('SELECT 1'),
  ]) {
    await expect(run()).rejects.toThrow(/^analytics: /);
    await expect(run()).rejects.not.toThrow(/posthog/i);
  }
});
