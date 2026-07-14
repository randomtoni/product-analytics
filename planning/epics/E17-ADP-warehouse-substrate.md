---
id: E17-ADP-warehouse-substrate
status: planned
area: adapters
touches: [query, node, core]
api_impact: additive
blocked_by: []
updated: 2026-07-13
---

# E17-ADP-warehouse-substrate — Warehouse substrate: events schema + typed view + DB-execute seam + config selection

## Why

The library's vendor-neutrality is currently **nominal** (identifiers de-branded, name scan green) but
not **protocol-level**: every working data path speaks PostHog's wire, and the only implemented query
backends target a PostHog-compatible host. The `WarehouseQueryAdapter` is a typed STUB (`throw`
/`NotImplementedError`) and is not even config-selectable — nothing writes to or reads from a consumer
warehouse. This epic lays the **foundation everything else in the self-host cycle binds to**: the
library-owned `events` table schema + a taxonomy-generated typed view, a shipped migration, a
role-named DB-execute protocol seam with a default driver behind an optional extra, and the
`warehouse_dsn` config field + factory selection ladder that makes the warehouse path selectable at
parity across both trees. It is the **one-way door** of the cycle — the column contract is frozen here
as a committed doc before any SQL or receiver binds to it.

## Success criteria

- A **library-owned `events` table schema** (columns `distinct_id`, `event`, `timestamp`, `uuid`
  UNIQUE, `properties` jsonb) + a **taxonomy-generated typed VIEW** generator (safe-cast projections
  over the JSONB base — never raw JSONB) + a shipped migration DDL. Receiver-writes and query-reads
  bind to ONE column contract by construction.
- A committed **`planning/WAREHOUSE-SCHEMA-CONTRACT.md`** (same rigor as `QUERY-ROW-CONTRACT.md`) that
  freezes the column contract, the view-generation rule, and the trait/group JSONB-nesting guard —
  reviewed before E18/E19 start. This is the schema-contract-freeze gate.
- A **role-named DB-execute protocol seam** (no driver handle crosses the seam — exactly like the
  existing `QueryTransport`/`Transport` injection), with a default driver (`pg` node-postgres in TS,
  `psycopg` v3 in Python) behind a `warehouse` extra / optional peer-dep. The seam is INJECTABLE (a
  fake in unit tests), so downstream warehouse stories are buildable/testable without a real Postgres.
- A **`warehouse_dsn` config field** on the query config + a factory selection **ladder** in
  `createQueryClient`/`create_query_client`: `warehouse_dsn` present ⇒ warehouse adapter; else
  `personalKey` + `queryEndpoint` ⇒ HTTP; else no-op. Selection is by field PRESENCE, not a `backend:`
  enum. Same warehouse-DSN field SHAPE is used on both the query config and (in E19) the receiver
  config, so self-host is one coherent "here's my Neon."
- **Bar A intact:** the warehouse adapter satisfies the same neutral `AnalyticsQueryClient` interface,
  unchanged. **Bar B intact:** a consumer selects the warehouse path by config alone (supply
  `warehouse_dsn`), zero library change.
- TS/Python parity on the schema, the view generator, the DB-execute seam, and the selection ladder.
- All gates green in both trees (build · test · typecheck · lint / pytest · ruff · mypy) + both
  neutrality scans.

## Stories

<Tentative slice — story files are drafted just-in-time at implement time.>

- **schema-contract-freeze** — write the committed `planning/WAREHOUSE-SCHEMA-CONTRACT.md` (column
  contract, typed-view rule, trait/group JSONB-nesting guard); the reviewed one-way-door gate before
  any SQL/receiver binds. No code.
- **events DDL + typed-view generator + migration** — library-owned `events` schema + taxonomy-driven
  typed-view generator (safe-cast over JSONB) + shipped migration DDL, at TS/Python parity.
- **DB-execute protocol seam + default driver behind the extra** — role-named DB-execute protocol
  (injectable, no driver handle crosses the seam) + default `pg`/`psycopg` driver gated behind a
  `warehouse` extra / optional peer-dep.
- **`warehouse_dsn` config field + factory selection ladder** — add the field + the presence-based
  selection ladder (C) to `createQueryClient`/`create_query_client` at parity; warehouse selection
  wires to the E18 adapter (stub-satisfying until E18 fills it in).

## Out of scope

- The warehouse query SQL itself (`trend`/`funnel`/`retention`/`raw_query` bodies) — **E18**. This epic
  ships the substrate the SQL binds to, plus the selection ladder that routes to it; the adapter stays
  stub-satisfying until E18.
- The ingest receiver + Neon persistence — **E19**. This epic OWNS the `events` schema the receiver
  writes to; the receiver itself lands in E19.
- Fully-local flags / static definitions — **E20**.
- The protocol-neutrality gate + acceptance recipe — **E21**.
- Any `backend:` enum or vendor-named switch — rejected by design (see Notes C).
- Data backfill / migration from an existing PostHog deployment — **not applicable**: the target
  consumer is GREENFIELD (no existing deployment or data to match), so there is no backfill concern.

## Notes

Locked by architect consult (2026-07-13) — do not re-litigate in stories.

- **The gap being closed (protocol-level, not nominal).** Vendor-neutrality today is nominal
  (identifiers de-branded, name scan green) but every working data path speaks PostHog's wire and the
  only query backends target a PostHog-compatible host. This cycle closes the protocol-level gap; this
  epic is its foundation.
- **A/C — library owns the schema; selection by field presence.** The LIBRARY owns the `events` table
  schema + typed view + migration DDL because **receiver-writes (E19) and query-reads (E18) must agree
  on ONE column contract** (`distinct_id`, `event`, `timestamp`, `uuid` UNIQUE, `properties` jsonb).
  The CONSUMER provisions Neon + runs the migration + (E19) mounts the handler. Config selection is by
  **PRESENCE of `warehouse_dsn`**, NOT a `backend:` enum — the enum was REJECTED (it breaks the
  field-presence convention every existing factory uses, and risks a vendor-named switch). The
  selection ladder: `warehouse_dsn` present ⇒ warehouse; else `personalKey`+`queryEndpoint` ⇒ HTTP;
  else no-op. Same warehouse-DSN field SHAPE on both the ingest/receiver config (E19) and the query
  config so self-host is one coherent "here's my Neon." — architect (2026-07-13)
- **B — the DB-execute seam mirrors the existing transport injection.** The driver
  (`pg` node-postgres / `psycopg` v3) sits BEHIND a role-named DB-execute protocol seam — no driver
  handle crosses the seam, exactly like the existing `QueryTransport`/`Transport` injection — gated
  behind a `warehouse` extra / optional peer-dep. Because the seam is INJECTABLE (a fake in unit
  tests), all downstream warehouse stories (E18) are buildable/testable WITHOUT a real Neon; only the
  E21 end-to-end test needs a real/local Postgres. Do NOT set a blocking `blocked_by` prerequisite on
  this epic. — architect (2026-07-13)
- **The schema is a ONE-WAY DOOR (risk-3).** Freeze it as the contract doc
  (`planning/WAREHOUSE-SCHEMA-CONTRACT.md`, same rigor as `QUERY-ROW-CONTRACT.md`) and get it reviewed
  BEFORE E18/E19 start — everything binds to it. — architect (2026-07-13)
- **Trait/group JSONB-nesting guard (carried from the wire shape, `ts/packages/node/src/wire-mapper.ts`).**
  Trait/group events nest de-branded `set`/`set_once`/`group_type`/`group_key`/`group_set` INSIDE
  `properties`. The receiver (E19) persists them as-is into the `properties` JSONB column; **no view
  column is named after them.** The schema contract must state this guard explicitly. — architect
  (2026-07-13)
- **Greenfield removes the data-migration concern.** The target consumer has no existing PostHog
  deployment or data, so there is no backfill/migration-from-vendor concern to design for. Note this in
  the schema contract.
- **The wire the receiver will speak already exists and is neutral.** E19's transport↔receiver wire
  REUSES the existing node batch envelope — `WireEvent { uuid, event, distinct_id, properties?,
  timestamp? }` (`ts/packages/node/src/wire-mapper.ts`), which is exactly the `events` column set. The
  schema is designed to receive that envelope directly; do NOT design the schema around PostHog's
  `$`-shape.

## Expansion path

The warehouse adapter (E18) and receiver (E19) fill in against this frozen substrate — additive, no
schema change. A future self-hosted-but-non-Neon Postgres-compatible warehouse is one new DB-execute
driver behind the same seam, zero schema/interface change. The typed-view generator extends additively
as the taxonomy grows. A `flag_definitions` table (E20 additive follow-up) is a new migration against
the same schema-owned migration mechanism.
