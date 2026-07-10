import type { ShapeOf, TaxonomyShape } from 'analytics-kit';
import { defineTaxonomy } from 'analytics-kit';
import { expect, expectTypeOf, test } from 'vitest';
import type { AnalyticsQueryClient } from './query-client';
import { WarehouseQueryAdapter, createWarehouseQueryAdapter } from './warehouse-query-adapter';

const taxonomy = defineTaxonomy({
  events: { order_placed: { amount: 'number' }, signed_up: {} },
  traits: { plan: 'string' },
});

type TX = ShapeOf<(typeof taxonomy)['decl']>;

const NOT_IMPLEMENTED = 'analytics: warehouse query adapter is not yet implemented';

// The `implements AnalyticsQueryClient<TX>` clause on the class compiles (checked by tsc);
// these assignability assertions pin that a WarehouseQueryAdapter instance IS a valid
// AnalyticsQueryClient — with zero change to the S1 interface (two adapters, one interface).

test('WarehouseQueryAdapter is assignable to AnalyticsQueryClient<TX> (bar-A proof, zero interface change)', () => {
  expectTypeOf<WarehouseQueryAdapter<TX>>().toExtend<AnalyticsQueryClient<TX>>();
  expectTypeOf<WarehouseQueryAdapter<TaxonomyShape>>().toExtend<AnalyticsQueryClient<TaxonomyShape>>();

  const adapter = new WarehouseQueryAdapter<TX>();
  const asClient: AnalyticsQueryClient<TX> = adapter;
  expect(asClient).toBe(adapter);
});

test('createWarehouseQueryAdapter returns something satisfying AnalyticsQueryClient<TX>', () => {
  expect(Object.keys(taxonomy.decl.events)).toEqual(['order_placed', 'signed_up']);

  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>();
  expect(client).toBeInstanceOf(WarehouseQueryAdapter);
  expect(typeof client.funnel).toBe('function');
  expect(typeof client.retention).toBe('function');
  expect(typeof client.trend).toBe('function');
  expect(typeof client.uniqueCount).toBe('function');
  expect(typeof client.rawQuery).toBe('function');
});

// Called through the AnalyticsQueryClient<TX> interface — the bar-A surface a consumer sees.

test('every method rejects with the neutral not-implemented error (no vendor leak, never computes)', async () => {
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>();

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
  const client: AnalyticsQueryClient<TX> = createWarehouseQueryAdapter<TX>();
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
