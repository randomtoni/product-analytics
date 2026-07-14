import type { DbColumn, DbExecute, DbExecuteResult } from './db-execute';

// The default DB-execute implementation, backed by the standard Postgres driver behind the
// optional `warehouse` peer-dep. Named by ROLE (never by driver): the exported surface says
// nothing about which client backs it, so a future non-Postgres warehouse is one new driver
// behind the SAME `DbExecute` seam. The driver is imported LAZILY (a runtime-only specifier)
// so importing this package WITHOUT the optional peer installed does NOT error — only
// CONSTRUCTING the default driver requires it.

// A runtime-only module specifier. The explicit `: string` widening is load-bearing: it keeps
// the compiler from narrowing to a literal type it would try to resolve at build time, so an
// uninstalled optional peer breaks neither typecheck nor build — resolution defers to runtime.
const DRIVER_MODULE: string = 'pg';

// The minimal, private structural mirror of the driver's result — the ONLY driver-shaped type
// in the package, owned here, never imported from the driver. The neutral surface never sees
// it. `dataTypeID` is the driver's numeric OID; we surface it as the neutral column `type`
// string only when the driver reports it.
interface DriverResult {
  rows: unknown[];
  fields: Array<{ name: string; dataTypeID: number }>;
}

interface DriverClient {
  connect(): Promise<void>;
  query(sql: string, params?: ReadonlyArray<unknown>): Promise<DriverResult>;
  end(): Promise<void>;
}

// A per-client type-parser override — instance-scoped, NOT the process-global `pg.types.setTypeParser`
// (a library must never mutate a consumer's global driver registry). Keyed by Postgres type OID.
interface DriverClientConfig {
  connectionString: string;
  types?: { getTypeParser(oid: number): (value: string) => unknown };
}

interface DriverModule {
  Client: new (config: DriverClientConfig) => DriverClient;
  // The driver's PROCESS-DEFAULT type-parser registry. Read (never mutated) so the instance-scoped
  // override can delegate every non-bigint OID to the driver's own default parser.
  types: { getTypeParser(oid: number): (value: string) => unknown };
}

// Postgres `int8`/bigint type OID. `pg` returns bigint as a STRING by default (an `int8` can exceed
// JS `Number.MAX_SAFE_INTEGER`, so `pg` refuses a lossy cast), but the neutral `DbExecuteResult`
// contract is that cells are neutral typed values — and the row builders (E18) read `count(...)`
// aggregates (bigint) as numbers. A count / actor-count / distinct-count fits well inside the safe
// range, so this instance-scoped parser coerces bigint → number, making the default driver HONEST to
// the neutral cell contract without a builder edit and without touching global driver state. Keyed by
// OID (the driver's own type identity), so it only coerces genuine bigint cells — a string breakdown
// value is a different OID and is untouched.
const PG_INT8_OID = 20;

// Coerce bigint (as reported: a decimal string) to a JS number for the neutral cell. Lossy past
// `Number.MAX_SAFE_INTEGER` — safe for the count aggregates it targets, but a true `int8` COLUMN
// selected via `raw_query` could exceed it; a per-query opt-out is the follow-up if one surfaces.
function parseBigIntAsNumber(value: string): number {
  return Number(value);
}

const DRIVER_MISSING =
  'analytics: the default warehouse driver requires the optional "warehouse" peer dependency; ' +
  'install it or supply your own DbExecute';

async function loadDriver(): Promise<DriverModule> {
  try {
    return (await import(DRIVER_MODULE)) as unknown as DriverModule;
  } catch {
    throw new Error(DRIVER_MISSING);
  }
}

function toResult(driverResult: DriverResult): DbExecuteResult {
  const columns: DbColumn[] = driverResult.fields.map((field) => ({ name: field.name }));
  const rows: ReadonlyArray<unknown>[] = driverResult.rows.map((row) =>
    Array.isArray(row) ? (row as unknown[]) : Object.values(row as Record<string, unknown>)
  );
  return { rows, columns };
}

export interface DefaultDbExecuteConfig {
  warehouseDsn: string;
}

// Construct the default `DbExecute` from a warehouse DSN. Lazily loads the optional driver on
// first call (never at import), opens a connection per execute, and maps the driver's result
// into the neutral `DbExecuteResult` — no driver handle crosses the returned seam.
export function createDefaultDbExecute(config: DefaultDbExecuteConfig): DbExecute {
  return async (sql, params) => {
    const driver = await loadDriver();
    // Instance-scoped type parser: coerce bigint (OID 20) to a JS number so `count(...)` aggregates
    // reach the row builders AS NUMBERS (the neutral cell contract), delegating every other OID to
    // the driver's own default. Scoped to THIS client — never the process-global registry.
    const client = new driver.Client({
      connectionString: config.warehouseDsn,
      types: {
        getTypeParser: (oid) =>
          oid === PG_INT8_OID ? parseBigIntAsNumber : driver.types.getTypeParser(oid),
      },
    });
    await client.connect();
    try {
      const driverResult = await client.query(sql, params);
      return toResult(driverResult);
    } finally {
      await client.end();
    }
  };
}
