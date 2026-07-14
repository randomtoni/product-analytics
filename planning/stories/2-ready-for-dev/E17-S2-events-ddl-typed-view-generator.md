---
id: E17-S2-events-ddl-typed-view-generator
epic: E17-ADP-warehouse-substrate
status: ready-for-dev
area: adapters
touches: [query, node]
depends_on: [E17-S1-schema-contract-freeze]
api_impact: additive
---

# E17-S2-events-ddl-typed-view-generator — events DDL + taxonomy-driven typed-view generator + migration

## Why

The receiver (E19) and the query SQL (E18) must agree on ONE column contract by construction. This
slice ships the library-owned `events` table DDL, a taxonomy-driven typed-VIEW generator (safe-cast
projections over the JSONB base), and the shipped migration DDL — at TS/Python parity, binding to
S1's frozen contract.

## Scope

### In

- Ship the **library-owned `events` table DDL** — a `CREATE TABLE` (idempotent, `IF NOT EXISTS`)
  with the S1-frozen columns: `distinct_id` (text, NOT NULL), `event` (text, NOT NULL), `timestamp`
  (timestamptz, NOT NULL), `uuid` (text/uuid, **UNIQUE** NOT NULL — the idempotency key), `properties`
  (`jsonb`, NOT NULL default `'{}'`). Exact column types settle at implement time within the S1
  contract (text vs uuid for `uuid`; timestamptz for `timestamp`); the column NAMES and the UNIQUE
  constraint are contract-fixed. No consumer/domain column — the schema is domain-neutral.
- Ship a **taxonomy-driven typed-VIEW generator** — a pure function that, given a taxonomy, emits a
  `CREATE OR REPLACE VIEW` (or the SQL string for one) projecting one **safe-cast** column per
  declared event property over the `properties` JSONB base, per S1's rule
  (`string → ::text`, `number → ::numeric`, `boolean → ::boolean`, `date → ::timestamptz`), plus the
  base columns (`distinct_id`, `event`, `timestamp`, `uuid`) passed through. The generator reads
  `PropType` off the taxonomy decl (`ts/packages/analytics-kit/src/taxonomy.ts` /
  `python/src/analytics_kit/taxonomy.py`); it bakes in NO consumer event/domain name (names come from
  the taxonomy at call time). It honors the S1 trait/group guard: **no view column named after**
  `set`/`set_once`/`group_type`/`group_key`/`group_set`.
- Ship the **migration DDL** as a shipped artifact the consumer runs against their Neon: the `events`
  DDL (and the mechanism by which the typed view is (re)generated). Shape (a `.sql` string constant,
  a small emitter function, or a migration file) settles at implement time — the requirement is that
  the consumer can obtain and run it, and it is idempotent. Do NOT ship a migration runner /
  execution here (that rides the S3 DB-execute seam and downstream stories); S2 ships the DDL and the
  generator, not the act of executing them.
- **TS/Python parity:** both trees ship the same `events` DDL, the same view-generation rule, and a
  generator that produces byte-equivalent view SQL for the same taxonomy (the SQL is Postgres — it is
  identical across languages; only the generator's host-language API is cased idiomatically). Unit
  tests assert the generated view SQL for a representative taxonomy in both trees.
- Co-locate the new module(s) with the warehouse surface (TS `ts/packages/node/src/query/`, Python
  `python/src/analytics_kit/query/`) unless the builder, on reading the tree, finds a better-fitting
  existing home — keep it in the `node`/query target (server-only; the browser never sees SQL).

### Out

- The DB-execute protocol seam + default driver behind the extra — **S3** (S2 emits SQL strings; it
  does NOT execute them or import a driver).
- The `warehouse_dsn` config field + selection ladder — **S4**.
- The warehouse query SQL bodies (`funnel`/`retention`/`trend`/`raw_query`) that read the view —
  **E18**.
- The ingest receiver that writes rows into `events` — **E19**.
- A migration RUNNER / execution harness — downstream (rides the S3 seam). S2 ships DDL + generator,
  not execution.
- `flag_definitions` table — E20 additive follow-up (the schema-owned migration mechanism this story
  establishes is what E20 extends).

## Acceptance criteria

- [ ] The library ships an idempotent `events` `CREATE TABLE` DDL with exactly the S1-frozen columns
      (`distinct_id`, `event`, `timestamp`, `uuid` UNIQUE, `properties` jsonb) and no domain column.
- [ ] The typed-VIEW generator, given a taxonomy, emits safe-cast JSONB projections per declared
      `PropType` (never raw JSONB), passes through the base columns, bakes in no consumer name, and
      names no view column after a trait/group key — verified by a unit test over a representative
      taxonomy.
- [ ] The migration DDL is a shipped artifact the consumer can obtain and run against their Neon; it
      is idempotent (safe to re-run).
- [ ] TS and Python ship the same `events` DDL and the same view-generation rule; the generator
      produces equivalent view SQL for the same taxonomy in both trees (parity test present in both).
- [ ] Generated SQL and DDL carry zero vendor token; both neutrality scans green. No `$`-prefixed
      column or PostHog-shaped name appears.
- [ ] All gates green in both trees (TS: build · test · typecheck · lint; Python: pytest · ruff ·
      mypy).

## Technical notes

Binds to **S1's frozen `planning/WAREHOUSE-SCHEMA-CONTRACT.md`** — the column contract, the safe-cast
view rule, and the trait/group guard are pre-resolved there; do not re-decide them here. S2 is the
executable form of S1's contract (the DDL + generator), the way `query-contract.fixtures.ts` is the
executable form of `QUERY-ROW-CONTRACT.md`.

**Pre-resolved decisions (locked by the epic Notes — architect 2026-07-13):**

- **The column set is fixed by S1** and IS the existing `WireEvent`
  (`ts/packages/node/src/wire-mapper.ts:36-42`). Do NOT introduce a `$`-shape or add columns; the
  receiver (E19) writes exactly this envelope. — architect (2026-07-13)
- **The typed VIEW is safe-cast projections over JSONB, never raw JSONB.** Read `PropType` off the
  taxonomy (`taxonomy.ts` — `PropType`, `PropDecl`, `TaxonomyDecl.events`; the Python analog in
  `taxonomy.py`). Cast per type (`string → ::text`, `number → ::numeric`, `boolean → ::boolean`,
  `date → ::timestamptz`). A missing/mistyped JSONB key yields NULL (safe cast, greenfield/loose
  posture). The warehouse-adapter stub's fill-in-seat comment already documents this intent
  (`ts/packages/node/src/query/warehouse-query-adapter.ts:18-21`, and the Python analog
  `warehouse_adapter.py:13-16`) — S2 realizes it. — architect (2026-07-13)
- **Trait/group guard:** never name a view column after `set`/`set_once`/`group_type`/`group_key`/
  `group_set` (they nest inside `properties`, `wire-mapper.ts:16-20`). — architect (2026-07-13)
- **Greenfield = idempotent, no backfill.** `CREATE TABLE IF NOT EXISTS` / `CREATE OR REPLACE VIEW`;
  no data migration from a legacy shape. — architect (2026-07-13)

**Parity discipline:** mirrors the `Python parity` cycle precedent — the SQL contract is shared; each
tree ships its own generator satisfying it, cased idiomatically. The generated SQL itself is
Postgres and therefore identical across languages; assert that equivalence in both trees' tests.

**No driver here.** S2 produces SQL as strings/artifacts. It does NOT import `pg`/`psycopg` or
execute anything — execution rides the S3 DB-execute seam. Keep S2 free of any driver dependency so
it builds/tests with zero warehouse extra installed.

## Shipped

<!-- Empty at draft. /implement-epics fills this once the story moves to stories/5-done/. -->
