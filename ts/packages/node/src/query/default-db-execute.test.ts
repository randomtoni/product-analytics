import { afterEach, expect, test, vi } from 'vitest';
import type { DbExecute } from './db-execute';
import { createDefaultDbExecute } from './default-db-execute';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('pg');
});

// The lazy-import guard (runtime side): merely IMPORTING this module (done at the top of the
// file) and CONSTRUCTING the default driver does not reach the optional peer — the driver is
// loaded only when the seam is CALLED. The compile-time side of the guard is proven by the
// build/typecheck gates passing with NO static `pg` reference in the package (the driver is an
// optional peer, not a dependency), so a bare static import would fail resolution.
test('importing + constructing the default driver does not require the optional peer', () => {
  const exec = createDefaultDbExecute({ warehouseDsn: 'postgres://localhost/db' });
  expect(typeof exec).toBe('function');
});

test('the default driver satisfies the DbExecute seam type', () => {
  const exec: DbExecute = createDefaultDbExecute({ warehouseDsn: 'postgres://localhost/db' });
  expect(exec).toBeTypeOf('function');
});

// When the optional peer cannot be loaded, the seam surfaces a neutral, vendor-generic error —
// never a raw module-not-found. Forced via a mock that fails the dynamic import, so the
// assertion holds regardless of whether the peer happens to be hoisted in the dev workspace.
test('calling the seam without the optional driver throws a neutral, vendor-free error', async () => {
  vi.doMock('pg', () => {
    throw new Error("Cannot find module 'pg'");
  });

  const exec = createDefaultDbExecute({ warehouseDsn: 'postgres://localhost/db' });

  await expect(exec('SELECT 1')).rejects.toThrow(/optional "warehouse" peer dependency/);
  await expect(exec('SELECT 1')).rejects.not.toThrow(/Cannot find module/i);
});

// With a stand-in driver present, the seam maps the driver's `{ rows, fields }` into the
// neutral `DbExecuteResult` (positional cell rows + name columns). Object-rows are flattened to
// positional cells in field order; array-rows pass through positionally.
test('the default driver maps the driver result into the neutral DbExecuteResult', async () => {
  const connect = vi.fn(async () => undefined);
  const end = vi.fn(async () => undefined);
  const query = vi.fn(async () => ({
    rows: [{ bucket: '2026-01-01', value: 5 }],
    fields: [
      { name: 'bucket', dataTypeID: 1184 },
      { name: 'value', dataTypeID: 1700 },
    ],
  }));
  class FakeClient {
    connect = connect;
    query = query;
    end = end;
    constructor(public config: { connectionString: string }) {}
  }
  vi.doMock('pg', () => ({ Client: FakeClient }));

  const exec = createDefaultDbExecute({ warehouseDsn: 'postgres://localhost/db' });
  const result = await exec('SELECT bucket, value FROM t', ['a']);

  expect(result.rows).toEqual([['2026-01-01', 5]]);
  expect(result.columns).toEqual([{ name: 'bucket' }, { name: 'value' }]);
  expect(query).toHaveBeenCalledWith('SELECT bucket, value FROM t', ['a']);
  expect(end).toHaveBeenCalledOnce();
});

// E21-S3 driver-conformance: `pg` returns Postgres bigint (`count(...)` aggregates, type OID 20) as
// a STRING by default. The row builders (E18) require numeric cells, so the default driver installs
// an INSTANCE-scoped type parser (never the process-global `setTypeParser`) coercing OID-20 → number,
// delegating every other OID to the driver's own default. This pins that wiring: a stand-in `pg`
// whose Client honors the configured `types.getTypeParser` yields a NUMBER for a bigint cell and
// leaves a non-bigint OID to the default parser.
test('the default driver installs an instance-scoped bigint→number parser (OID 20), delegating other OIDs', async () => {
  const defaultTextParser = vi.fn((v: string) => v);
  const seenConfig: { types?: { getTypeParser(oid: number): (v: string) => unknown } } = {};
  class FakeClient {
    connect = vi.fn(async () => undefined);
    // Uses the CONFIGURED per-instance parser to decode each field's raw string by its dataTypeID —
    // exactly what real `pg` does with a per-client `types` override.
    query = vi.fn(async () => {
      const parse = (oid: number, raw: string): unknown =>
        seenConfig.types?.getTypeParser(oid)(raw) ?? raw;
      return {
        rows: [[parse(20, '7'), parse(1184, '2026-01-01')]],
        fields: [
          { name: 'n', dataTypeID: 20 },
          { name: 'bucket', dataTypeID: 1184 },
        ],
      };
    });
    end = vi.fn(async () => undefined);
    constructor(config: { connectionString: string; types?: { getTypeParser(oid: number): (v: string) => unknown } }) {
      seenConfig.types = config.types;
    }
  }
  // The module also exposes the process-DEFAULT `types.getTypeParser` the override delegates to.
  vi.doMock('pg', () => ({
    Client: FakeClient,
    types: { getTypeParser: () => defaultTextParser },
  }));

  const exec = createDefaultDbExecute({ warehouseDsn: 'postgres://localhost/db' });
  const result = await exec('SELECT count(*) AS n, bucket FROM t');

  // The bigint cell is a NUMBER (coerced), not the raw string; the non-bigint OID went to the default.
  expect(result.rows).toEqual([[7, '2026-01-01']]);
  expect(typeof result.rows[0][0]).toBe('number');
  expect(defaultTextParser).toHaveBeenCalledWith('2026-01-01');
});

test('the default driver closes the connection even when the query throws', async () => {
  const end = vi.fn(async () => undefined);
  class FakeClient {
    connect = vi.fn(async () => undefined);
    query = vi.fn(async () => {
      throw new Error('boom');
    });
    end = end;
    constructor(public config: { connectionString: string }) {}
  }
  vi.doMock('pg', () => ({ Client: FakeClient }));

  const exec = createDefaultDbExecute({ warehouseDsn: 'postgres://localhost/db' });

  await expect(exec('SELECT 1')).rejects.toThrow('boom');
  expect(end).toHaveBeenCalledOnce();
});
