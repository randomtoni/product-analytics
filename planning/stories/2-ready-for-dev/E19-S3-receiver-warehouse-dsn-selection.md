---
id: E19-S3-receiver-warehouse-dsn-selection
epic: E19-NODE-ingest-receiver-persistence
status: ready-for-dev
area: node
touches: [adapters, core]
depends_on: [E19-S1-neutral-receiver-core]
api_impact: additive
---

# E19-S3-receiver-warehouse-dsn-selection — receiver config `warehouse_dsn` (C-symmetric with the query config) + factory-builds-`DbExecute`

## Why

The receiver core (S1) holds a `DbExecute`; something must build it from the consumer's Neon DSN at the
config boundary. This slice adds the receiver-side config field — the SAME `warehouse_dsn` field SHAPE
the E17 query config already uses (C symmetry: one coherent "here's my Neon" across read and write) —
and a from-config factory that builds the `DbExecute` from the DSN and injects it into the receiver
core. The core stays DSN-free.

## Scope

### In

- Add a **receiver config** carrying a **`warehouse_dsn` field with the SAME SHAPE as the query config**:
  - **Python:** `warehouse_dsn: str | None = None` (mirror `QueryClientConfig` in
    `python/src/analytics_kit/query/config.py`, same `extra="forbid"` posture if a Pydantic model).
  - **TS:** `warehouseDsn?: string` (mirror `QueryClientConfig.warehouseDsn` in
    `ts/packages/node/src/query/config.ts`).
  - This is C symmetry from the epic Notes: the query side (E17-S4) PINNED the field name/shape; the
    receiver mirrors it so self-host reads as one "here's my Neon" across read and write. Do NOT introduce
    a differently-named DSN field.
- Add a **from-config factory that builds the receiver's `DbExecute` from the DSN** — the structural twin
  of E17-S4's `createWarehouseQueryAdapterFromConfig` (which reads the DSN, lazily imports the
  `warehouse`-extra driver, builds the default `DbExecute`, and injects it):
  - **TS:** e.g. `createReceiverFromConfig(config)` — reads `config.warehouseDsn`, lazily imports the
    E17 `warehouse` optional-peer-dep driver, builds the default `DbExecute` from the DSN
    (`createDefaultDbExecute`), and hands it to the S1 receiver core (and, where a mount is returned, to
    the S4 mount). Role-named, never a vendor.
  - **Python:** e.g. `create_receiver_from_config(config)` — reads `config.warehouse_dsn`, lazily imports
    the `analytics-kit[warehouse]` driver, builds the default `DbExecute` from the DSN, injects it into
    the S1 core (and the S2 mounts). Role-named.
  - The exact factory name settles at implement time; PIN that it mirrors E17-S4's factory pattern (read
    DSN at the boundary → lazily build driver → build default `DbExecute` → inject). Reuse E17-S3's
    `createDefaultDbExecute`/`create_default_db_execute` + `DefaultDbExecuteConfig` — do NOT re-implement
    a driver build.
- **The DSN is read ONLY at this factory boundary; the receiver core (S1) and mounts (S2/S4) hold only
  the injected `DbExecute`, never a DSN or driver handle.** Same split as the query side: a DSN is
  credential-shaped config, read at the boundary, never stored on the working object. The core/mount
  modules never import `pg`/`psycopg` — only this factory boundary does (lazily).
- **Wire the factory into the mounts.** The from-config factory is the single ergonomic entry a consumer
  uses: `warehouse_dsn` in → a mount-ready handler out (the S2/S4 mount, backed by a DSN-built
  `DbExecute`). Presence-based, no `backend:` enum (consistent with every existing factory ladder —
  E17-S4's Notes C). If `warehouse_dsn` is absent, define the neutral behavior (a clear neutral error /
  no-op — mirror the query factory's absence handling; pin the choice).
- **TS/Python parity** on the field name shape, the from-config factory pattern, the DSN-read-at-boundary
  invariant, and the "core holds only `DbExecute`" split.

### Out

- The neutral parse/decompress/upsert core — **S1** (S3 supplies the `DbExecute` it consumes).
- The framework mounts themselves (Django/FastAPI/ASGI; Express/Next/plain) — **S2** (Python) / **S4**
  (TS). S3 wires config → driver → those mounts; it does not write the mount bodies.
- The `DbExecute` seam + the default driver + the `warehouse` extra — **E17-S3** (shipped; S3 consumes
  `createDefaultDbExecute` and the extra, does not re-define them).
- The query-side `warehouse_dsn` field + its factory — **E17-S4** (shipped; S3 mirrors its field SHAPE
  and factory PATTERN, does not touch the query config/factory).
- Any `backend:` enum or vendor-named switch — rejected by design (E17-S4 Notes C). Do NOT add one.

## Acceptance criteria

- [ ] A receiver config carries `warehouse_dsn: str | None = None` (Python) / `warehouseDsn?: string`
      (TS) — the SAME field SHAPE as the E17 query config (C symmetry); no differently-named DSN field.
- [ ] A from-config factory (mirroring E17-S4's `createWarehouseQueryAdapterFromConfig` pattern) reads
      the DSN, lazily imports the E17 `warehouse` driver, builds the default `DbExecute` via
      `createDefaultDbExecute`/`create_default_db_execute`, and injects it into the S1 receiver core /
      the mounts.
- [ ] The receiver core and mounts hold only the injected `DbExecute` — never a DSN or driver handle;
      they never import `pg`/`psycopg`. Only this factory boundary imports the driver (lazily). Both
      neutrality scans green.
- [ ] Selection is presence-based (a `warehouse_dsn` supplied ⇒ a DSN-built receiver); no `backend:`
      enum; absent-DSN behavior is a defined neutral error/no-op (pinned, mirroring the query factory).
- [ ] Bar B: a consumer selects self-host persistence by supplying `warehouse_dsn` alone (same coherent
      field as the query side) and mounting the returned handler — zero library edit.
- [ ] Factory tests in both trees inject/build the `DbExecute` using the E17-S3 fake seam (no real
      Postgres); the DSN-never-stored-on-core invariant is asserted; the receiver constructs without the
      `pg`/`psycopg` extra present (lazy import). TS/Python parity; all gates green in both trees.

## Technical notes

**Mirror E17-S4's factory pattern EXACTLY — the FACTORY builds the driver, the working object holds only
the `DbExecute` (architect ruling, 2026-07-14, carried from the query side).** Read E17-S4 before
writing:

- `createWarehouseQueryAdapterFromConfig` (TS) / `create_warehouse_query_adapter_from_config` (Python)
  reads `warehouse_dsn`, lazily imports the `warehouse`-extra driver, builds the default `DbExecute`, and
  injects it into the adapter constructor — the adapter holds a `DbExecute`-typed field and NEVER sees a
  DSN or driver handle. S3's receiver factory is the WRITE-side twin of this: same read-DSN-at-boundary,
  same lazy driver build, same inject-only-the-`DbExecute`. The structural precedent is
  `createHttpQueryAdapterFromConfig` reading `config.fetch` and passing it in.
- **Reuse E17-S3's `createDefaultDbExecute`/`create_default_db_execute` + `DefaultDbExecuteConfig`** to
  build the driver from the DSN. Do NOT re-implement a driver build — the default driver + its lazy
  `warehouse`-extra import already exist and are shipped.

**Pre-resolved decisions (locked by the epic Notes):**

- **C symmetry — same `warehouse_dsn` field SHAPE as the query config.** Receiver-side selection uses the
  SAME field SHAPE as the E17 query config, so self-host is one coherent "here's my Neon" across read and
  write. The query side (E17-S4) pinned it; the receiver mirrors it. — architect (2026-07-13)
- **Selection is by field PRESENCE, NOT a `backend:` enum.** Every existing factory selects by presence
  (ingest, flags, query); the enum was rejected (breaks the convention, risks a vendor-named switch).
  `warehouse_dsn` present ⇒ a DSN-built receiver. — architect (2026-07-13, carried from E17-S4 Notes C)
- **The DSN is read at the config/factory boundary, never stored on the working object** — a DSN is
  credential-shaped config (like `personalKey`), read once at the boundary and never held on the
  receiver core / mount. This keeps the core module import-clean (no optional-extra import risk) and
  unit-testable against the S3 fake `DbExecute`. — architect (2026-07-13, 2026-07-14)
- **Injectable ⇒ no real Postgres this epic.** The factory builds a real `DbExecute` from a DSN in
  production, but tests inject/build against the E17-S3 fake seam — no real Neon. — architect (2026-07-13)

**`touches: core`** because the shared config/factory posture (presence-based selection, DSN-at-boundary,
the neutral core interface) is a seam-level convention the receiver honors — mirroring the E17-S4
`touches: core` rationale. No change to the `core` package itself is expected; flag it if the builder
finds one is needed.

**Overlap heads-up (see epic dependency graph):** S3 wraps the S2 Python mounts (and the S4 TS mounts)
with the from-config factory and touches the receiver package `__init__`/exports that S2 also touches.
Run S2 → S3 serially in the Python tree. On the TS side, S3's factory wraps S4's mounts — sequence S3
after (or coordinated with) S4 for the TS from-config wiring, OR land the TS factory as an S3 add over
the S4 mounts; the orchestrator picks the serial order for the overlapping TS receiver files. The DSN
field + the config type are the low-risk part; the mount-wiring is where the file overlap lives.

**Test posture.** Assert: the factory reads `warehouse_dsn` and builds a `DbExecute` (against the E17-S3
fake — e.g. monkeypatch/inject `create_default_db_execute` as the query-side selection tests do, per the
E17-S4 shipped note on the Python eager-load); the receiver core/mount never receives a DSN or handle
(the DSN-never-stored guard); the receiver constructs with no `pg`/`psycopg` installed (lazy import
proven). Mirror E17-S4's selection tests.

## Shipped

<!-- Empty at draft. /implement-epics fills this on move to stories/5-done/. Do not hand-edit. -->
