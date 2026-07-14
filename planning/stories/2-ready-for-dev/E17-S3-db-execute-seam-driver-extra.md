---
id: E17-S3-db-execute-seam-driver-extra
epic: E17-ADP-warehouse-substrate
status: ready-for-dev
area: adapters
touches: [query, node]
depends_on: [E17-S1-schema-contract-freeze]
api_impact: additive
---

# E17-S3-db-execute-seam-driver-extra — role-named DB-execute protocol seam + default driver behind the `warehouse` extra

## Why

The warehouse path needs to reach Postgres without a driver handle leaking across the seam — exactly
like the existing `QueryTransport`/`FetchLike` HTTP-send injection. This slice defines the
role-named, injectable DB-execute protocol and a default driver behind an optional `warehouse` extra,
so every downstream warehouse story (E18) is buildable and unit-testable against a fake, with no real
Neon.

## Scope

### In

- Define a **role-named DB-execute protocol** — the injectable seam the warehouse adapter (E18) and
  any DDL execution route through. It mirrors the EXISTING transport injection exactly:
  - **TS:** a small interface in the query surface (`ts/packages/node/src/query/`), mirroring
    `FetchLike` (`ts/packages/node/src/config.ts:8`) and the `QueryTransport` posture — a single
    method that takes a SQL string + parameter values and returns a NEUTRAL result shape (rows +
    columns, e.g. reusing/aligning with the neutral `QueryResult` row/column vocabulary), never a
    driver handle. Name by ROLE (never a vendor, never `pg`). No `pg` type appears in the interface.
  - **Python:** a `runtime_checkable` `Protocol` in `python/src/analytics_kit/query/client.py` (or a
    co-located module), mirroring `QueryTransport` (`client.py:180-205`) — a single sync method
    taking SQL + params, returning a neutral result shape (mirror `NeutralResponse`'s "status/body
    but for rows" role — a neutral rows/columns object), never a `psycopg` handle. `runtime_checkable`
    so a config field can hold it opaque under `arbitrary_types_allowed`.
- The seam is **INJECTABLE**: a fake/in-memory implementation satisfies it for unit tests (the same
  way the query transport is faked today), so E18's SQL bodies are testable without a real Postgres.
  Ship at least a minimal fake or test double proving injectability (or leave the concrete test doubles
  to E18 but ensure the seam shape supports them — builder's call, but injectability must be
  demonstrable).
- Ship the **default driver behind the `warehouse` extra / optional peer-dep** — a role-named default
  implementation of the DB-execute protocol backed by the real driver:
  - **Python:** `psycopg` v3, gated behind the `analytics-kit[warehouse]` optional-dependency extra
    (matching the existing `[fastapi]`/`[django]` convention in `pyproject.toml:12-18`). The exact
    pin (`psycopg[binary]` v3 version specifier) settles at implement time; the extra SLUG
    `warehouse` is PINNED. The default driver import must be lazy/guarded so importing the query
    package without the extra installed does NOT error — only constructing the default driver does.
  - **TS:** `pg` (node-postgres) as an OPTIONAL peer-dep — add a `peerDependencies` entry +
    `peerDependenciesMeta.<name>.optional: true` to `ts/packages/node/package.json` (which has no
    peerDeps today). The exact version + the meta entry mechanics settle at implement time; the extra
    NAME concept (`warehouse`, an optional peer-dep) is PINNED. The default driver import must be
    lazy/guarded so the node package imports without `pg` installed.
- **TS/Python parity:** same seam role + shape, same default-driver-behind-an-optional-extra posture,
  same "no driver handle crosses the seam" invariant.
- **Do NOT set a blocking `blocked_by` on the epic for this.** Because the seam is injectable, E18–E20
  build/test against the fake; only E21's end-to-end test needs a real Postgres.

### Out

- Executing the actual warehouse query SQL — **E18** (S3 ships the seam + driver; E18 writes the SQL
  that routes through it).
- Wiring `warehouse_dsn` into config + the factory selection ladder — **S4** (S4 constructs the
  default driver from the DSN and routes selection to the warehouse adapter).
- The `events` DDL / typed-view generator — **S2** (S3 provides the execution seam those artifacts
  will later run through, but does not run them).
- The end-to-end zero-egress acceptance test against real Postgres — **E21**.

## Acceptance criteria

- [ ] A role-named DB-execute protocol/interface exists in both trees, mirroring the existing
      transport injection (TS `FetchLike`/`QueryTransport`; Python `QueryTransport` Protocol). It
      takes SQL + params and returns a NEUTRAL rows/columns result — no `pg`/`psycopg` handle crosses
      the seam. The name is role-based, never a vendor.
- [ ] The seam is injectable: a fake satisfies it and is usable in unit tests without a real Postgres
      (demonstrated, so E18 can rely on it).
- [ ] A default driver implementation exists behind the `warehouse` extra: Python
      `analytics-kit[warehouse]` (`psycopg` v3, matching the `[fastapi]`/`[django]` convention); TS
      `pg` as an optional peer-dep (`peerDependencies` + `peerDependenciesMeta.optional`).
- [ ] The default driver import is lazy/guarded: importing the query/node package WITHOUT the extra
      installed does not error; only constructing the default driver requires the driver present.
- [ ] The extra slug is exactly `warehouse` in both ecosystems (pinned — not re-decided).
- [ ] TS/Python parity on the seam role, shape, and driver-behind-extra posture; `pg`/`psycopg` never
      appears in the neutral seam type.
- [ ] Both neutrality scans green (the role name leaks no vendor); all gates green in both trees.

## Technical notes

**Mirror the EXISTING transport injection — this is a port of a proven pattern, not a new design.**
The library already injects an HTTP send hook the exact way S3 must inject a DB-execute hook:

- **Python reference:** `QueryTransport` Protocol (`python/src/analytics_kit/query/client.py:180-205`)
  — `runtime_checkable`, a single `send(...)` method returning the neutral `NeutralResponse`
  (`status` + `body`), held opaque on `QueryClientConfig` under `arbitrary_types_allowed`
  (`query/config.py:36-42`, the `transport: QueryTransport | None = None` field). The DB-execute
  Protocol is the same shape for SQL: one method, SQL + params in, a neutral rows/columns result out,
  no driver handle. — architect (2026-07-13)
- **TS reference:** `FetchLike` (`ts/packages/node/src/config.ts:8`) injected into the HTTP query
  adapter (`create-query-client.ts` passes `config.fetch`; `http-query-adapter.ts` holds
  `private readonly fetch: FetchLike`). The DB-execute interface is the SQL analog — a role-named
  method injected the same way. — architect (2026-07-13)

**Pre-resolved decisions (locked by the epic Notes):**

- **No driver handle crosses the seam** — exactly like the transport seam returning `NeutralResponse`
  rather than a `fetch` `Response`. The DB-execute seam returns a neutral rows/columns object, and the
  adapter reads it — `pg`/`psycopg` types never appear in any exported or seam-facing type.
  — architect (2026-07-13)
- **Extra slug is PINNED: `warehouse`** in BOTH ecosystems — Python `analytics-kit[warehouse]`
  (matching the existing `[fastapi]` extra convention, `pyproject.toml:12-18`), TS an optional
  peer-dep on `pg`. This name is DECIDED, not an implement-time open question. What legitimately
  settles per-ecosystem at build time is ONLY the manifest mechanics: the exact `pyproject.toml`
  `[project.optional-dependencies]` `psycopg[binary]` v3 pin, and the `ts/packages/node/package.json`
  `peerDependencies` + `peerDependenciesMeta.<name>.optional: true` entry for `pg`. Pin the slug now;
  defer only the packaging detail. — epic-refiner (2026-07-14)
- **Injectable ⇒ no blocking `blocked_by`.** The seam being fakeable is what lets E18–E20 build and
  unit-test without a real Neon; only E21's acceptance test needs real/local Postgres. Do NOT add a
  blocking prerequisite to the epic. — architect (2026-07-13)
- **Default driver:** `psycopg` v3 (Python) / `pg` node-postgres (TS), each a role-named default
  implementation of the DB-execute protocol, lazily imported so the package imports without the extra.
  — architect (2026-07-13)

**Runs in parallel with S2** (both depend only on S1). S2 emits SQL; S3 provides the seam that
executes SQL. They meet in S4 (which constructs the driver from `warehouse_dsn`) and E18 (which
writes the SQL that routes through the seam).

## Shipped

<!-- Empty at draft. /implement-epics fills this once the story moves to stories/5-done/. -->
