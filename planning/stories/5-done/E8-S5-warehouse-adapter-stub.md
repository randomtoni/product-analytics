---
id: E8-S5-warehouse-adapter-stub
epic: E8-QRY-query-client
status: ready-for-dev
area: query
touches: [adapters]
depends_on: [E8-S1-query-client-seam]
api_impact: additive
---

# E8-S5-warehouse-adapter-stub — Warehouse query adapter: interface-satisfying typed stub (bar-A proof)

## Why

A second query backend that typechecks against `AnalyticsQueryClient<TX>` unchanged — proving swapping the HTTP adapter for a warehouse/SQL adapter is one adapter, zero consumer change (bar A). Ships as a typed stub only, with the intended per-method SQL mapping documented so filling it in later is fill-in-the-blanks, not a redesign.

## Scope

### In

- A warehouse query adapter module in `@analytics-kit/node` (e.g. `query/warehouse-query-adapter.ts`), named **by role** (`WarehouseQueryAdapter` / `createWarehouseQueryAdapter`), implementing `AnalyticsQueryClient<TX>` in full — every method present, correctly typed.
- Each method is a **typed `NotImplemented`-style stub**: it satisfies the signature (returns `Promise<QueryResult>`) but throws a clear neutral `not-implemented` error (or returns an empty `QueryResult` with a documented "stub" marker — pick one and be consistent; a throw is clearer for "not yet a real backend"). The point is the shape typechecks, not that it computes.
- **Documented intended per-method SQL mapping** (in code comments kept minimal per project convention, or a short adjacent doc block): funnel/retention/trend/uniqueCount → the SQL they will emit against the **taxonomy-generated typed view** (per REFERENCE-BACKEND.md §E8-S5 — Postgres SQL over the typed view, not raw JSONB, not DuckDB-first). Enough that a future implementer fills in a body, not a design.
- A test asserting the stub **structurally satisfies** `AnalyticsQueryClient<TX>` (implements-clause / assignability compiles) — this test IS the bar-A proof: a second adapter satisfies the same interface unchanged.
- Export `createWarehouseQueryAdapter` from `@analytics-kit/node`'s `index.ts` (so a consumer can select it by config in a future release; for R1 it is the proof + the fill-in seat).

### Out

- The actual SQL implementation / a live warehouse connection — this release ships the stub only; filling it in is a future additive adapter (bar A: one new adapter, zero interface change).
- Taxonomy→DDL / typed-view generation — that lives in the reference-backend repo (below the seam), not the library. This stub only *documents* the view it will target.
- Wiring it into `createQueryClient`'s config selection as a live option — R1 selects the HTTP adapter; the warehouse adapter is constructable but not the default. (Config-driven adapter selection between the two is a future additive step, not R1 scope.)

## Acceptance criteria

- [ ] `WarehouseQueryAdapter` implements `AnalyticsQueryClient<TX>` — all five members present and correctly typed; the implements-clause compiles with zero change to the S1 interface (bar-A proof: a second backend satisfies the same neutral interface unchanged).
- [ ] Each method is a typed stub that does not compute (throws a neutral `not-implemented` error or returns a marked-empty `QueryResult`) — never a partial real implementation, never a live connection.
- [ ] The intended per-method SQL mapping is documented (funnel/retention/trend/uniqueCount → SQL over the taxonomy-generated typed view) — concise, enough to be fill-in-the-blanks.
- [ ] No vendor name in the adapter's name or exports (named by role). No SQL string names a consumer event/domain — the mapping is described generically against the typed view.
- [ ] Typecheck + lint + test + build green; the structural-satisfaction test is present and passing.

## Technical notes

- **Warehouse target is a stub only.** Define the interface + a typed `NotImplemented`-style stub so the shape is proven and "a new adapter is fill-in-the-blanks" (BRIEF deliverable 4). — architect (2026-07-07, epic Notes).
- **The stub's first real fill-in is a Postgres-SQL adapter targeting the taxonomy-generated typed view** (not raw JSONB, not DuckDB-first); the documented per-method SQL mapping ports to DuckDB at T2 (~90% dialect overlap). Still a typed stub in R1 — no scope change. — REFERENCE-BACKEND.md §E8-S5 / Implications for release-1 epics.
- **This story is the bar-A proof.** Its whole reason to exist is to demonstrate two adapters satisfy one interface. If the stub can't implement `AnalyticsQueryClient<TX>` without an interface change, that's a bug in S1's neutrality — surface it, don't patch it by widening the interface toward one backend.
- **`rawQuery(expr)` for a warehouse adapter treats `expr` as SQL** (vs. HogQL for the HTTP adapter) — the exact dialect split that justifies `rawQuery` taking a plain string and naming no dialect (S1 Technical notes). The stub documents this: its `rawQuery` would pass `expr` to the SQL engine.
- **Only depends on S1** (the interface), NOT on S2/S3/S4 — it can be built in parallel with the HTTP adapter track once the seam exists (`depends_on: [E8-S1]`). It reads REFERENCE-BACKEND.md for the intended SQL mapping.
- **Name by role.** `WarehouseQueryAdapter` — an internal adapter module of the node package, named by role, never by vendor (BRIEF).

## Shipped

## Shipped

> Captured by `implement-epics` on 2026-07-08. Closes E8's feature set — THE bar-A proof.

- **Files added (node/query):** `warehouse-query-adapter.ts` (role-named `WarehouseQueryAdapter`/`createWarehouseQueryAdapter` `implements AnalyticsQueryClient<TX>` in full — 5 methods each a NEUTRAL not-implemented throw `'analytics: warehouse query adapter is not yet implemented'`, never computes/connects; a tight doc block mapping each method → Postgres SQL over the taxonomy-generated typed VIEW per REFERENCE-BACKEND §E8-S5, `rawQuery(expr)`=SQL vs HogQL) + test
- **Files changed:** node `index.ts` (+`WarehouseQueryAdapter`/`createWarehouseQueryAdapter` exports)
- **New public API:** `@analytics-kit/node` `WarehouseQueryAdapter`/`createWarehouseQueryAdapter` — constructable + exported but NOT the default (`createQueryClient` selects `QueryNoop`/HTTP; config-driven HTTP↔warehouse selection is a future additive step). Named by role, no vendor, no consumer-event in the SQL mapping.
- **THE bar-A proof:** `implements AnalyticsQueryClient<TX>` with the S1 interface BYTE-FOR-BYTE unchanged (`git diff packages/analytics-kit/` empty). Reviewer independently probed: the 0-arg stub bodies (dropped params for `no-unused-vars`, mirroring `QueryNoop`) do NOT weaken typing — the taxonomy spec params are enforced at the CALL SITE through an `AnalyticsQueryClient<TX>`-typed ref (invalid event / missing `within` / non-string rawQuery all fail to compile). Two real adapters (HTTP + warehouse), one interface, zero consumer change.
- **Tests added:** node +4 (bar-A `toExtend<AnalyticsQueryClient<TX>>()` typed+default taxonomy + runtime assignment; factory returns interface-satisfying; every method rejects neutral not-implemented; message names-no-vendor) → 175; seam 172 unchanged. **Typecheck independently confirmed exit 0** (post-S4 lesson).
- **Commit:** `E8-S5-warehouse-adapter-stub — Warehouse query adapter: interface-satisfying typed stub (bar-A proof)` on `core-cycle`
- **Reviewer notes:** SHIP — 0 critical, 2 suggestions (member-count test lockstep on a 6th primitive; keep the throw-not-empty on fill-in); E8-close-ready
- **E10 note:** the example consumer wires `createQueryClient(config)` + codes to `AnalyticsQueryClient<TX>` — should NEVER import `createWarehouseQueryAdapter` directly (proof/fill-in seat, not a consumer path); exercise the typed spec surface (funnel/retention/trend/uniqueCount taxonomy-keyed) + show the config-only no-op default; do NOT select the warehouse adapter by config (not wired, by design).
