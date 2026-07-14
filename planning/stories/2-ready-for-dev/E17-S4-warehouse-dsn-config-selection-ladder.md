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
  `AnalyticsQueryClient` and `throw`s / `raise`s `NotImplementedError`. S4 makes it CONSTRUCTABLE from
  a `warehouse_dsn` (wiring the S3 driver into it), so selection + construction are proven; the
  method BODIES stay stub-satisfying until E18 fills them. The factory selecting and constructing the
  adapter is the deliverable — actually querying is E18.
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
- [ ] The warehouse adapter is constructed from the DSN (via the S3 default DB-execute driver) and
      returned as an `AnalyticsQueryClient` — bar A intact (same neutral interface, unchanged). Its
      method bodies remain stub-satisfying (E18 fills them).
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
  `warehouse_adapter.py`). S4 makes it constructable from the DSN + S3 driver and selectable; E18
  fills the bodies. Bar A holds because the interface is unchanged. — architect (2026-07-13)
- **Consumes S3's driver.** The `warehouse_dsn` rung builds the S3 default DB-execute driver from the
  DSN and injects it into the warehouse adapter. Because the seam is injectable, the selection test
  uses the S3 fake — no real Neon. `depends_on` S3 (the seam) + S1 (the frozen contract the adapter
  will bind to). — architect (2026-07-13)

**`touches: core`** because the shared config/factory posture (presence-based selection, the neutral
adapter interface) is a seam-level convention; the change lives in the `node`/query target but
honors the core seam contract (bars A/B). No change to the `core` package itself is expected — flag it
if the builder finds one is needed.

## Shipped

<!-- Empty at draft. /implement-epics fills this once the story moves to stories/5-done/. -->
