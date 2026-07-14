---
id: E17-S4-warehouse-dsn-config-selection-ladder
epic: E17-ADP-warehouse-substrate
status: ready-for-dev
area: adapters
touches: [query, node, core]
depends_on: [E17-S1-schema-contract-freeze, E17-S3-db-execute-seam-driver-extra]
api_impact: additive
---

# E17-S4-warehouse-dsn-config-selection-ladder — `warehouse_dsn` config field + presence-based factory selection ladder

## Why

Bar B says a consumer selects the warehouse path by config alone, zero library change. This slice adds
the `warehouse_dsn` field to the query config and the presence-based selection ladder to both
factories, routing a DSN-configured consumer to the warehouse adapter (the E18 stub until E18 fills
it). Self-host becomes "here's my Neon" — one coherent field, no `backend:` enum.

## Scope

### In

- Add a **`warehouse_dsn` config field** to the query config in both trees:
  - **TS:** add `warehouseDsn?: string` to `QueryClientConfig` (`ts/packages/node/src/query/config.ts`).
  - **Python:** add `warehouse_dsn: str | None = None` to `QueryClientConfig`
    (`python/src/analytics_kit/query/config.py`), keeping the existing `extra="forbid"` posture.
  - Use the SAME field SHAPE that E19's receiver config will use for its warehouse DSN, so self-host
    is one coherent "here's my Neon" across read and write. (E19 owns the receiver config; S4 only
    fixes the query-side field name/shape both will share — pin `warehouse_dsn` / `warehouseDsn`.)
- Add the **presence-based selection ladder** to both factories:
  - **TS `createQueryClient`** (`ts/packages/node/src/query/create-query-client.ts`): FIRST rung —
    `config.warehouseDsn` present ⇒ construct the warehouse adapter (via the S3 default DB-execute
    driver built from the DSN) and return it. ELSE the existing ladder unchanged: `personalKey` set
    but no `queryEndpoint` ⇒ warn + no-op; `personalKey` + `queryEndpoint` ⇒ HTTP adapter; neither ⇒
    no-op.
  - **Python `create_query_client`** (`python/src/analytics_kit/query/factory.py`): the same first
    rung — `config.warehouse_dsn` present ⇒ warehouse adapter (via the S3 driver from the DSN); else
    the existing `personal_key`/`query_endpoint` ⇒ HTTP-or-no-op ladder unchanged.
  - Selection is by field **PRESENCE**, never a `backend:` enum (the enum is rejected by design —
    Notes C). Precedence: `warehouse_dsn` wins when present (it is the explicit self-host signal).
- **Route to the existing `WarehouseQueryAdapter`** (`ts/.../query/warehouse-query-adapter.ts` /
  `python/.../query/warehouse_adapter.py`) — currently a typed STUB that satisfies
  `AnalyticsQueryClient` and `throw`s / `raise`s `NotImplementedError`. S4 makes it CONSTRUCTABLE with
  an injected S3 `DbExecute` and selectable, so selection + construction are proven; the method BODIES
  stay stub-satisfying until E18 fills them. The factory selecting and constructing the adapter is the
  deliverable — actually querying is E18.
  - **Driver-build ownership: the FACTORY builds the driver, the adapter holds only the `DbExecute`
    (architect ruling, 2026-07-14).** Mirror `createHttpQueryAdapterFromConfig` reading `config.fetch`
    and passing it into the adapter: add a thin **`createWarehouseQueryAdapterFromConfig(config)`**
    (TS) / **`create_warehouse_query_adapter_from_config(config)`** (Python) that reads
    `warehouse_dsn`, **lazily imports the S3 `warehouse`-extra driver, builds the default `DbExecute`
    from the DSN**, and injects it into the `WarehouseQueryAdapter` constructor. The adapter gains a
    `DbExecute`-typed field (TS `options.dbExecute`; Python `db_execute:` kwarg), holds it opaque, and
    **NEVER sees a DSN or a driver handle** and never imports `pg`/`psycopg`. This keeps the adapter
    module import-clean (no optional-extra import risk) and unit-testable against the S3 fake exec —
    exactly why `HttpQueryAdapter` holds a `FetchLike` rather than building its own client. The lazy
    driver import belongs at THIS factory boundary (where "a `warehouse_dsn` is present ⇒ we need the
    driver" is decided), not in the adapter constructor. `createQueryClient`/`create_query_client`
    stays a pure selection ladder that delegates the warehouse rung to this thin factory.
- Update the factory selection tests in both trees to cover the new first rung (a `warehouse_dsn`
  config selects the warehouse adapter; existing rungs unchanged), using the S3 fake DB-execute seam
  so no real Postgres is needed.
- **TS/Python parity** on the field name shape, the ladder order, and the precedence rule.

### Out

- The warehouse query SQL bodies — **E18** (S4 selects + constructs the adapter; E18 makes its methods
  compute). The adapter's methods stay stub-satisfying after S4.
- The receiver config's own `warehouse_dsn` field — **E19** (S4 pins the shared field SHAPE on the
  query side; E19 mirrors it on the receiver config).
- The DB-execute seam + driver themselves — **S3** (S4 consumes them: it builds the default driver
  from the DSN and injects it into the warehouse adapter).
- Any `backend:` enum or vendor-named switch — rejected by design (Notes C). Do NOT add one.

## Acceptance criteria

- [ ] `QueryClientConfig` carries a `warehouseDsn?` (TS) / `warehouse_dsn: str | None = None` (Python)
      field; Python keeps `extra="forbid"`.
- [ ] `createQueryClient` / `create_query_client` select by PRESENCE: `warehouse_dsn` present ⇒
      warehouse adapter (first rung, wins over HTTP); else `personalKey`+`queryEndpoint` ⇒ HTTP; else
      no-op. No `backend:` enum anywhere.
- [ ] The warehouse adapter is constructed via a thin `createWarehouseQueryAdapterFromConfig` (TS) /
      `create_warehouse_query_adapter_from_config` (Python) that reads `warehouse_dsn`, lazily imports
      the S3 driver, builds the default `DbExecute` from the DSN, and injects it; the adapter holds a
      `DbExecute` field (never a DSN/handle) and is returned as an `AnalyticsQueryClient` — bar A
      intact (same neutral interface, unchanged). Its method bodies remain stub-satisfying (E18 fills
      them).
- [ ] Bar B intact: a consumer selects the warehouse path by supplying `warehouse_dsn` alone — zero
      library change.
- [ ] Factory selection tests in both trees cover the new rung using the S3 fake seam (no real
      Postgres); existing HTTP/no-op rungs still pass.
- [ ] TS/Python parity on field shape, ladder order, and precedence; both neutrality scans green; all
      gates green in both trees.

## Technical notes

**Extend the EXISTING presence-based ladders — do not restructure them.** Both factories already
select by field presence today:

- **TS** (`ts/packages/node/src/query/create-query-client.ts:21-44`): `personalKey === undefined` ⇒
  `QueryNoop`; `queryEndpoint === undefined` ⇒ warn + `QueryNoop`; else HTTP adapter. S4 prepends the
  `warehouseDsn` rung ahead of the `personalKey` check.
- **Python** (`python/src/analytics_kit/query/factory.py:24-42`): `personal_key is None or
  query_endpoint is None` ⇒ `QueryNoop`; else `_build_http_query_client`. S4 prepends the
  `warehouse_dsn` rung.

**Pre-resolved decisions (locked by the epic Notes):**

- **Selection is by field PRESENCE, NOT a `backend:` enum.** The enum was REJECTED — it breaks the
  field-presence convention every existing factory uses (ingest, flags, query all select by presence)
  and risks a vendor-named switch. `warehouse_dsn` present ⇒ warehouse; else the existing
  `personalKey`+`queryEndpoint` ⇒ HTTP; else no-op. — architect (2026-07-13)
- **Same `warehouse_dsn` field SHAPE on both the query config (here) and the receiver config (E19)**
  so self-host is one coherent "here's my Neon." Pin the query-side shape now; E19 mirrors it.
  — architect (2026-07-13)
- **Route to the existing stub.** The `WarehouseQueryAdapter` typed stub already satisfies
  `AnalyticsQueryClient` and `throw`s/`raise`s (TS `warehouse-query-adapter.ts`, Python
  `warehouse_adapter.py`). S4 makes it constructable with an injected `DbExecute` and selectable; E18
  fills the bodies. Bar A holds because the interface is unchanged. — architect (2026-07-13)
- **Consumes S3's driver — FACTORY-builds-driver, adapter holds only the `DbExecute` (architect,
  2026-07-14).** The warehouse rung delegates to a thin `createWarehouseQueryAdapterFromConfig` (the
  structural twin of `createHttpQueryAdapterFromConfig`, which reads `config.fetch` and injects it):
  read `warehouse_dsn`, lazily import the S3 `warehouse`-extra driver, build the default `DbExecute`,
  inject it into the adapter constructor. The adapter holds a `DbExecute`-typed field and never sees
  the DSN or a driver handle — the same split as `HttpQueryAdapter` holding a `FetchLike`. Rationale:
  the lazy optional-extra import belongs at the config/factory boundary (keeps the adapter module
  import-clean); the adapter stays unit-testable against the S3 fake exec (the selection test injects
  the fake — no real Neon); a DSN is credential-shaped config, read at the boundary and never stored
  on the working object (like `personalKey`). `depends_on` S3 (the seam) + S1 (the frozen contract).
  — architect (2026-07-13, 2026-07-14)

**Cross-story dependency on S3's fake (story-refiner 2026-07-14).** S4's selection tests inject the S3
fake `DbExecute` (the AC's "S3 fake seam, no real Postgres"). S3 ships that fake as a **reusable shared
test helper** (pinned in S3's Scope) — S4 imports it, does not reinvent one. The `depends_on: [S1, S3]`
already forces S3 to land first; no separate sequencing note needed (unlike E15-S4↔S3, this dep is a
real `depends_on`, not a soft cross-reference).

**`touches: core`** because the shared config/factory posture (presence-based selection, the neutral
adapter interface) is a seam-level convention; the change lives in the `node`/query target but
honors the core seam contract (bars A/B). No change to the `core` package itself is expected — flag it
if the builder finds one is needed.

> Reviewer suggestion (2026-07-14): the TS/Python selection tests differ in fidelity (TS drives the
> real lazy factory; Python monkeypatches `create_default_db_execute` because its driver load is
> eager). Verified honest + idiomatic — the real `create_query_client`→warehouse rung IS exercised
> end-to-end, only the leaf driver-build is faked. On record, no action.
> Reviewer suggestion (2026-07-14): warehouse-adapter export-parity gap — Python's public `__init__`
> exports `WarehouseQueryAdapter`/`create_warehouse_query_adapter`/`create_warehouse_query_adapter_from_config`;
> TS's `node/src/index.ts` exports none of the warehouse-adapter symbols (pre-existing, extended here).
> DEFER to the E17 improvement pass: align both trees to the HTTP-adapter export precedent
> (`HttpQueryAdapter`/`createHttpQueryAdapter*` posture), symmetrically — whichever posture HTTP uses,
> warehouse matches, in both trees. Bar B holds regardless (config-only access via `createQueryClient`).

## Shipped

> Captured by `implement-epics` on 2026-07-14.

- **Files changed:** TS `ts/packages/node/src/query/config.ts`, `create-query-client.ts`, `warehouse-query-adapter.ts` (+ `.test.ts`s); Python `python/src/analytics_kit/query/config.py`, `factory.py`, `warehouse_adapter.py`, `query/__init__.py`, `__init__.py` (+ `tests/test_query_client.py`, `tests/test_warehouse_query_adapter.py`)
- **New public API:** `warehouseDsn?`/`warehouse_dsn` on `QueryClientConfig`; `createWarehouseQueryAdapter(options)` + `createWarehouseQueryAdapterFromConfig(config)` (TS) / `create_warehouse_query_adapter(*, db_execute)` + `create_warehouse_query_adapter_from_config(config)` (Python) — the latter Python-exported, TS export posture to be aligned in the improvement pass (see suggestion)
- **Tests added:** warehouse-rung selection + DSN-precedence-over-HTTP + DSN-never-stored guard + constructs-without-`pg`-peer + required-`dbExecute`-field, both trees; existing HTTP/no-op rungs still green
- **Commit:** this story's ship commit on `main` (see `git log`)
- **Reviewer notes:** verdict SOUND, no criticals; 2 suggestions — the test-fidelity divergence is on-record (no action), the export-parity gap deferred to the E17 improvement pass
- **Cross-story seams exposed:** the warehouse path is now **config-selectable** — `warehouse_dsn` present ⇒ `WarehouseQueryAdapter` (first rung, wins over HTTP), constructed via the from-config factory that builds the S3 `DbExecute` from the DSN and injects it; the adapter holds only the `DbExecute` (never a DSN/handle). **E18** fills the adapter's stub method bodies against `this.dbExecute`/`self._db_execute` — no seam/factory change needed. **E19** mirrors the pinned `warehouse_dsn` field shape onto the receiver config.

## Follow-up

> E17 improvement pass (2026-07-14) — verified clean by architect-reviewer.

- Aligned the warehouse-adapter export posture to the HTTP-adapter precedent (config-only in both trees): narrowed Python's public `__init__` to stop exporting `WarehouseQueryAdapter`/`create_warehouse_query_adapter`/`create_warehouse_query_adapter_from_config` (submodule-only now); TS already matched. Both trees now reach the warehouse adapter only via `createQueryClient`/`create_query_client`. **Bar B verified intact** — a `warehouse_dsn` config still resolves to the warehouse adapter. (reviewer suggestion — export-parity gap)
