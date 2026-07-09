import type { QueryResult, ShapeOf, TaxonomyShape } from 'analytics-kit';
import { defineTaxonomy } from 'analytics-kit';
import { expect, expectTypeOf, test } from 'vitest';
import type {
  AnalyticsQueryClient,
  FunnelSpec,
  RetentionSpec,
  TrendSpec,
  UniqueCountSpec,
} from './query-client';

const taxonomy = defineTaxonomy({
  events: {
    order_placed: { amount: 'number' },
    signed_up: {},
    logged_out: {},
  },
  traits: { plan: 'string' },
});

type TX = ShapeOf<(typeof taxonomy)['decl']>;

declare const client: AnalyticsQueryClient<TX>;

// Compile-time assertions only — validated by `tsc --noEmit`, never executed.

const _funnelStepsTypeCheck = (): Promise<QueryResult> =>
  client.funnel({
    steps: ['signed_up', 'order_placed'],
    within: { value: 7, unit: 'day' },
    breakdown: 'plan',
  });

const _trendEventTypeChecks = (): Promise<QueryResult> =>
  client.trend({ event: 'order_placed', aggregation: 'total', window: { value: 30, unit: 'day' } });

const _retentionEventsTypeCheck = (): Promise<QueryResult> =>
  client.retention({
    cohortEvent: 'signed_up',
    returnEvent: 'order_placed',
    periods: 8,
    granularity: 'week',
  });

const _uniqueCountEventTypeChecks = (): Promise<QueryResult> =>
  client.uniqueCount({ event: 'logged_out', window: { value: 1, unit: 'month' } });

const _rawQueryTakesAPlainString = (): Promise<QueryResult> =>
  client.rawQuery('SELECT count() FROM events');

const _rejectsUndeclaredEventNames = (): void => {
  // @ts-expect-error 'checkout' is not a declared event
  void client.funnel({ steps: ['signed_up', 'checkout'], within: { value: 7, unit: 'day' } });
  // @ts-expect-error 'checkout' is not a declared event
  void client.trend({ event: 'checkout', aggregation: 'total', window: { value: 7, unit: 'day' } });
  // @ts-expect-error 'checkout' is not a declared event
  void client.retention({ cohortEvent: 'checkout', returnEvent: 'order_placed', periods: 4, granularity: 'day' });
  // @ts-expect-error 'checkout' is not a declared event
  void client.uniqueCount({ event: 'checkout', window: { value: 7, unit: 'day' } });
};

const _rejectsWrongSpecShape = (): void => {
  // @ts-expect-error trend requires an aggregation
  void client.trend({ event: 'order_placed', window: { value: 7, unit: 'day' } });
  // @ts-expect-error 'quarter' is not a Granularity
  void client.retention({ cohortEvent: 'signed_up', returnEvent: 'order_placed', periods: 4, granularity: 'quarter' });
  // @ts-expect-error 'fortnight' is not a Duration unit
  void client.uniqueCount({ event: 'logged_out', window: { value: 1, unit: 'fortnight' } });
  // @ts-expect-error 'median' is not a neutral Aggregation
  void client.trend({ event: 'order_placed', aggregation: 'median', window: { value: 7, unit: 'day' } });
};

// Under the default (untyped) TaxonomyShape, event names widen to `string` — the E7 escape hatch.
const _defaultTaxonomyWidensToString = (): void => {
  const loose = {} as AnalyticsQueryClient<TaxonomyShape>;
  void loose.funnel({ steps: ['anything', 'goes'], within: { value: 7, unit: 'day' } });
  void loose.trend({ event: 'whatever', aggregation: 'unique', window: { value: 7, unit: 'day' } });
};

expectTypeOf<FunnelSpec<TX>['steps']>().toEqualTypeOf<Array<'order_placed' | 'signed_up' | 'logged_out'>>();
expectTypeOf<TrendSpec<TX>['event']>().toEqualTypeOf<'order_placed' | 'signed_up' | 'logged_out'>();
expectTypeOf<RetentionSpec<TX>['cohortEvent']>().toEqualTypeOf<'order_placed' | 'signed_up' | 'logged_out'>();
expectTypeOf<UniqueCountSpec<TX>['event']>().toEqualTypeOf<'order_placed' | 'signed_up' | 'logged_out'>();

test('query-client taxonomy-typing compile-time pins are present (validated by tsc, not executed)', () => {
  expect(Object.keys(taxonomy.decl.events)).toEqual(['order_placed', 'signed_up', 'logged_out']);
  expect([
    _funnelStepsTypeCheck,
    _trendEventTypeChecks,
    _retentionEventsTypeCheck,
    _uniqueCountEventTypeChecks,
    _rawQueryTakesAPlainString,
    _rejectsUndeclaredEventNames,
    _rejectsWrongSpecShape,
    _defaultTaxonomyWidensToString,
  ]).toHaveLength(8);
});

// --- own keyof pin (does NOT touch the frozen-15 AnalyticsProvider pin nor the NodeAnalytics pin) ---

test('AnalyticsQueryClient exposes exactly its own five query members, each returning Promise<QueryResult>', () => {
  expectTypeOf<keyof AnalyticsQueryClient<never>>().toEqualTypeOf<
    'funnel' | 'retention' | 'trend' | 'uniqueCount' | 'rawQuery'
  >();
  expectTypeOf<AnalyticsQueryClient<never>['funnel']>().returns.toEqualTypeOf<Promise<QueryResult>>();
  expectTypeOf<AnalyticsQueryClient<never>['retention']>().returns.toEqualTypeOf<Promise<QueryResult>>();
  expectTypeOf<AnalyticsQueryClient<never>['trend']>().returns.toEqualTypeOf<Promise<QueryResult>>();
  expectTypeOf<AnalyticsQueryClient<never>['uniqueCount']>().returns.toEqualTypeOf<Promise<QueryResult>>();
  expectTypeOf<AnalyticsQueryClient<never>['rawQuery']>().returns.toEqualTypeOf<Promise<QueryResult>>();
});
