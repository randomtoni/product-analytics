// Reusable test double for the DB-execute seam — a shared helper (mirroring the
// `query-contract.fixtures.ts` convention) that S3, S4, and E18 tests import so none of them
// needs a real Postgres. It never ships: this file is not re-exported from the package entry,
// so it stays out of `dist`. It is the concrete proof the seam is injectable.
import type { DbExecute, DbExecuteResult } from './db-execute';

// One recorded invocation of the fake — the SQL and the positional params it was called with,
// so a test can assert what SQL the adapter routed through the seam.
export interface RecordedExec {
  sql: string;
  params: ReadonlyArray<unknown> | undefined;
}

// A `DbExecute` that records every call and returns a canned `DbExecuteResult`. The default
// result is an empty rows/columns payload; pass a canned result (or a per-call resolver) to
// drive E18's normalization bodies without a driver. The recorded calls are exposed for
// assertions on the SQL/params that crossed the seam.
export interface FakeDbExecute {
  execute: DbExecute;
  calls: RecordedExec[];
}

const EMPTY_RESULT: DbExecuteResult = { rows: [], columns: [] };

export function createFakeDbExecute(
  canned: DbExecuteResult | ((call: RecordedExec) => DbExecuteResult) = EMPTY_RESULT
): FakeDbExecute {
  const calls: RecordedExec[] = [];
  const execute: DbExecute = async (sql, params) => {
    const call: RecordedExec = { sql, params };
    calls.push(call);
    return typeof canned === 'function' ? canned(call) : canned;
  };
  return { execute, calls };
}
