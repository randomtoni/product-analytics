// The DB-execute seam: the SQL analog of the HTTP `FetchLike` transport hook. The warehouse
// adapter (E18) and any DDL execution route SQL through this injectable seam, so no driver
// handle ever crosses it — exactly like `FetchLike` returning a neutral response the adapter
// reads rather than a live `fetch` `Response`. Name by ROLE, never by driver: nothing here
// references a specific Postgres client. A fake satisfies it for unit tests without a real DB.

// One result column — a name and an optional driver-reported type. Mirrors the neutral
// `QueryColumn` (`name`/`type?`), kept DISTINCT and ordered so an empty result still carries
// its schema. `type` is optional: the driver reports it, but a raw exec need not depend on it.
export interface DbColumn {
  name: string;
  type?: string;
}

// The neutral raw-exec payload — its OWN backend-agnostic shape, DISTINCT from `QueryResult`
// (which stamps `generatedAt`/`fromCache` + per-primitive typed rows an exec cannot own) and
// from `NeutralResponse` (the HTTP-shaped `{ status, body }`). This is the raw-payload tier
// BELOW `QueryResult`: E18's adapter bodies normalize a `DbExecuteResult` INTO a `QueryResult`
// themselves, exactly as the HTTP adapter normalizes its wire envelope. `rows` are
// arrays-of-arrays (positional cells) — the native driver shape the existing `zipRow` helper
// already expects — keyed positionally by `columns` order.
export interface DbExecuteResult {
  rows: ReadonlyArray<ReadonlyArray<unknown>>;
  columns: DbColumn[];
}

// The injectable DB-execute hook — a callable seam mirroring `FetchLike`'s posture (a plain
// callable, not a named-method object). Takes SQL + positional params and resolves to the
// neutral `DbExecuteResult`. Async, mirroring `FetchLike`/`fetch` and the async
// `AnalyticsQueryClient` methods. No driver handle is exposed.
export type DbExecute = (
  sql: string,
  params?: ReadonlyArray<unknown>
) => Promise<DbExecuteResult>;
