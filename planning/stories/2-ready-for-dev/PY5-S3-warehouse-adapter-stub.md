---
id: PY5-S3-warehouse-adapter-stub
epic: PY5-QRY-query-client
status: ready-for-dev
area: query
touches: [adapters]
depends_on: [PY5-S1-query-protocol-specs-result-factory]
api_impact: additive
---

# PY5-S3-warehouse-adapter-stub — Warehouse query adapter: interface-satisfying typed stub (bar-A proof)

## Why

A second query backend that satisfies `AnalyticsQueryClient` unchanged — proving swapping the HTTP adapter for a warehouse/SQL adapter is one adapter, zero consumer change (bar A). Ships as a typed stub only, with the intended per-method SQL mapping documented so filling it in later is fill-in-the-blanks, not a redesign. It is the Python realization of TS `E8-S5` and depends only on PY5-S1 (the Protocol), so it can be built in parallel with the HTTP adapter track.

## Scope

### In

- A warehouse query adapter module in `query/` (e.g. `query/warehouse_adapter.py`), named **by role** (`WarehouseQueryAdapter` / `create_warehouse_query_adapter`), satisfying `AnalyticsQueryClient` in full — every method present, correctly typed.
- Each method is a **typed `NotImplemented`-style stub**: a plain **`def` (NOT `async def`)** returning `QueryResult` per the sync Protocol posture (the TS stub is `async` → `Promise`; the Python port is SYNC — an `async def` returns a coroutine, not `QueryResult`, and would FAIL the `_conforms` check, so the sync signature is load-bearing for the bar-A proof), that raises a clear neutral not-implemented error (e.g. `raise NotImplementedError("analytics-kit: warehouse query adapter is not yet implemented")`). The point is the shape satisfies the Protocol, not that it computes — never a partial real implementation, never a live connection.
- **Documented intended per-method SQL mapping** (a concise dev-only comment / docstring block): funnel/retention/trend/unique_count → the SQL they will emit against a taxonomy-generated typed view. Enough that a future implementer fills in a body, not a design. `raw_query(expr)` would treat `expr` as SQL (vs the HTTP adapter's query-dialect string) — the exact dialect split that justifies `raw_query` taking a plain string naming no dialect.
- A test asserting the stub **structurally satisfies** `AnalyticsQueryClient` via the shipped **`_conforms(client: AnalyticsQueryClient) -> None` type-level sink** (a `WarehouseQueryAdapter` instance is passed to it; mypy proves satisfaction without subclassing — the exact pattern PY4-S1 shipped as `_conforms` / `test_server_adapter_conforms_to_spi_structurally` in `tests/test_server_adapter.py`, and the same sink PY5-S1 defines). This test IS the bar-A proof: a second adapter satisfies the same interface unchanged, ZERO change to the PY5-S1 Protocol.
- Export `create_warehouse_query_adapter` from the `query/` module (constructable + exported, but NOT the default — `create_query_client` selects the no-op / HTTP adapter; config-driven HTTP↔warehouse selection is a future additive step).

### Out

- The actual SQL implementation / a live warehouse connection — this cycle ships the stub only; filling it in is a future additive adapter (bar A: one new adapter, zero interface change).
- Taxonomy→DDL / typed-view generation — below the seam, not the library. This stub only *documents* the view it will target.
- Wiring it into `create_query_client`'s config selection as a live option — this cycle selects the no-op / HTTP adapter; the warehouse adapter is constructable but not the default.

## Acceptance criteria

- [ ] `WarehouseQueryAdapter` satisfies `AnalyticsQueryClient` — all five members present and correctly typed; a `_conforms(client: AnalyticsQueryClient) -> None`-style type-level test (the PY5-S1 sink) passes a `WarehouseQueryAdapter` instance and compiles under mypy with ZERO change to the PY5-S1 Protocol (bar-A proof: a second backend satisfies the same neutral interface unchanged — the same `_conforms` pattern PY4-S1 shipped).
- [ ] Each method is a typed stub that does not compute (raises a neutral not-implemented error) — never a partial real implementation, never a live connection.
- [ ] The intended per-method SQL mapping is documented (funnel/retention/trend/unique_count → SQL over the taxonomy-generated typed view) — concise, enough to be fill-in-the-blanks.
- [ ] No vendor name in the adapter's name or exports (named by role); no SQL string names a consumer event/domain — the mapping is described generically against the typed view.
- [ ] `uv run mypy` (strict), `uv run ruff check`, `uv run pytest` all exit 0; the structural-satisfaction test is present and passing; `grep -ri posthog` over `query/` clean.

## Technical notes

- **CONTRACT reference (port TO):** `ts/packages/node/src/query/warehouse-query-adapter.ts` — a role-named class satisfying `AnalyticsQueryClient` in full, each method a neutral not-implemented throw, with a documented per-method SQL mapping.
- **Warehouse target is a stub only** (TS `E8-S5`, architect): define the interface + a typed `NotImplemented`-style stub so the shape is proven and "a new adapter is fill-in-the-blanks" (BRIEF deliverable). The first real fill-in is a SQL adapter over the taxonomy-generated typed view (not raw JSONB) — the documented per-method mapping is enough to be fill-in-the-blanks, still a typed stub this cycle (no scope change).
- **This story IS the bar-A proof.** Its whole reason to exist is to demonstrate two adapters satisfy one Protocol. If the stub can't satisfy `AnalyticsQueryClient` without a Protocol change, that's a bug in PY5-S1's neutrality — surface it, don't patch it by widening the Protocol toward one backend.
- **`raw_query(expr)` for a warehouse adapter treats `expr` as SQL** (vs the HTTP adapter's query-dialect string) — the exact dialect split that justifies `raw_query` taking a plain string and naming no dialect (PY5-S1). The stub documents this.
- **Only depends on PY5-S1** (the Protocol), NOT on PY5-S2 — it can be built in parallel with the HTTP adapter track once the seam exists.
- **Name by role:** `WarehouseQueryAdapter` — an internal adapter module named by role, never by vendor.
- **Neutrality lesson — docstrings ship** vendor-neutral; the SQL mapping names no consumer event/domain.

## Shipped

<!-- Captured by implement-epics on close. -->
