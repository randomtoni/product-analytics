import { expect, expectTypeOf, test } from 'vitest';
import type { DbColumn, DbExecute, DbExecuteResult } from './db-execute';
import { createFakeDbExecute } from './db-execute.fixtures';

test('DbExecute is a callable seam: SQL + optional positional params in, DbExecuteResult out', () => {
  expectTypeOf<DbExecute>().toBeFunction();
  expectTypeOf<DbExecute>().parameter(0).toEqualTypeOf<string>();
  expectTypeOf<DbExecute>().parameter(1).toEqualTypeOf<ReadonlyArray<unknown> | undefined>();
  expectTypeOf<DbExecute>().returns.resolves.toEqualTypeOf<DbExecuteResult>();
});

test('DbExecuteResult carries positional cell-array rows + ordered name/type columns', () => {
  expectTypeOf<DbExecuteResult['rows']>().toEqualTypeOf<ReadonlyArray<ReadonlyArray<unknown>>>();
  expectTypeOf<DbExecuteResult['columns']>().toEqualTypeOf<DbColumn[]>();
  expectTypeOf<DbColumn['name']>().toEqualTypeOf<string>();
  expectTypeOf<DbColumn['type']>().toEqualTypeOf<string | undefined>();
});

test('the fake satisfies the DbExecute seam and returns its canned result (injectable)', async () => {
  const canned: DbExecuteResult = {
    rows: [
      ['2026-01-01', 5],
      ['2026-01-02', 7],
    ],
    columns: [{ name: 'bucket', type: 'timestamptz' }, { name: 'value', type: 'numeric' }],
  };
  const fake = createFakeDbExecute(canned);
  const exec: DbExecute = fake.execute;

  const result = await exec('SELECT bucket, value FROM analytics_events_typed', []);

  expect(result).toEqual(canned);
  expect(result.rows[0]).toEqual(['2026-01-01', 5]);
});

test('the fake records the SQL + params that crossed the seam (E18 can assert routing)', async () => {
  const fake = createFakeDbExecute();

  await fake.execute('SELECT 1');
  await fake.execute('SELECT $1', ['x']);

  expect(fake.calls).toEqual([
    { sql: 'SELECT 1', params: undefined },
    { sql: 'SELECT $1', params: ['x'] },
  ]);
});

test('the fake defaults to an empty rows/columns result when uncanned', async () => {
  const fake = createFakeDbExecute();

  const result = await fake.execute('SELECT 1');

  expect(result.rows).toEqual([]);
  expect(result.columns).toEqual([]);
});

test('the fake accepts a per-call resolver so a test can shape the result from the SQL', async () => {
  const fake = createFakeDbExecute((call) => ({
    rows: [[call.sql]],
    columns: [{ name: 'echoed' }],
  }));

  const result = await fake.execute('SELECT now()');

  expect(result.rows).toEqual([['SELECT now()']]);
  expect(result.columns).toEqual([{ name: 'echoed' }]);
});
