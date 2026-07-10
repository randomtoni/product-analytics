import { expectTypeOf, expect, test } from 'vitest';
import type { QueryColumn, QueryResult } from './index';

test('QueryResult + QueryColumn are exported from the seam entry (neutral, shared by every adapter)', () => {
  const result: QueryResult = {
    rows: [{ cohort: '2026-07-01', period: 3, count: 42, rate: 0.31 }],
    columns: [
      { name: 'cohort', type: 'string' },
      { name: 'period' },
      { name: 'count' },
      { name: 'rate' },
    ],
    generatedAt: '2026-07-08T00:00:00.000Z',
    fromCache: true,
  };
  expect(result.rows).toHaveLength(1);
  expect(result.columns).toHaveLength(4);
});

test('QueryResult surface is exactly rows/columns/generatedAt/fromCache?', () => {
  expectTypeOf<keyof QueryResult>().toEqualTypeOf<'rows' | 'columns' | 'generatedAt' | 'fromCache'>();
});

test('rows cell values are unknown (adapter/engine-reported; a snapshot job casts at its own schema)', () => {
  expectTypeOf<QueryResult['rows']>().toEqualTypeOf<ReadonlyArray<Record<string, unknown>>>();
});

test('columns is a distinct ordered array so an empty result still carries its schema', () => {
  expectTypeOf<QueryResult['columns']>().toEqualTypeOf<ReadonlyArray<QueryColumn>>();
  const emptyButSchemaed: QueryResult = {
    rows: [],
    columns: [{ name: 'cohort' }, { name: 'count' }],
    generatedAt: '2026-07-08T00:00:00.000Z',
  };
  expect(emptyButSchemaed.rows).toHaveLength(0);
  expect(emptyButSchemaed.columns).toHaveLength(2);
});

test('fromCache? is genuinely optional (the wire is_cached is conditionally present)', () => {
  expectTypeOf<QueryResult>().toEqualTypeOf<{
    rows: ReadonlyArray<Record<string, unknown>>;
    columns: ReadonlyArray<QueryColumn>;
    generatedAt: string;
    fromCache?: boolean;
  }>();
  const noCacheFlag: QueryResult = {
    rows: [],
    columns: [],
    generatedAt: '2026-07-08T00:00:00.000Z',
  };
  expect(noCacheFlag.fromCache).toBeUndefined();
});

test('QueryColumn is name + optional type', () => {
  expectTypeOf<QueryColumn>().toEqualTypeOf<{ name: string; type?: string }>();
});
