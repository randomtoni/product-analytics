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

interface DriverModule {
  Client: new (config: { connectionString: string }) => DriverClient;
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
    const client = new driver.Client({ connectionString: config.warehouseDsn });
    await client.connect();
    try {
      const driverResult = await client.query(sql, params);
      return toResult(driverResult);
    } finally {
      await client.end();
    }
  };
}
