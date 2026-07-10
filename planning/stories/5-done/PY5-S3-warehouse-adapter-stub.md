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

> Captured by `implement-epics` on 2026-07-10.

- **Files added:** `python/src/analytics_kit/query/warehouse_adapter.py` (`WarehouseQueryAdapter` + `create_warehouse_query_adapter` + documented per-method SQL mapping), `tests/test_warehouse_query_adapter.py`
- **Files changed:** `query/__init__.py` + `__init__.py` (top-level export of the warehouse adapter — the constructable-not-config-selected extension point)
- **New public API:** `WarehouseQueryAdapter`, `create_warehouse_query_adapter` (a typed sync-`def` stub satisfying `AnalyticsQueryClient`, raising a neutral not-implemented error)
- **Tests added:** `test_both_query_adapters_satisfy_one_protocol_unchanged` (the consolidated bar-A proof — BOTH `Http` + `Warehouse` adapters through the `_conforms` sink) + warehouse conformance/sync/neutral-error/role-name/SQL-mapping-neutrality tests
- **Commit:** `core-cycle` (message = story title)
- **Reviewer notes:** clean — bar-A proof **negative-controlled 3 ways** (`async def` / dropped member / wrong return → all fail at `_conforms`; the PY5-S1 Protocol is UNTOUCHED — it didn't move for a second backend). The SQL-mapping docstring dropped HogQL/Postgres/DuckDB/JSONB from the TS reference — a neutrality IMPROVEMENT (adapt, don't copy). Top-level warehouse export **endorsed**: the config-selected `HttpQueryAdapter` stays internal (a consumer never constructs it — hiding it protects the config seam), the not-selected warehouse adapter must be reachable to be usable (watch-item: retreat it to `query/`-only if config-driven HTTP↔warehouse selection lands later).
> Reviewer suggestion (2026-07-10): cosmetic — one test line (`test_warehouse_query_adapter.py:113`) is 101 chars vs `line-length=100`; `ruff check` passes (E501 not enforced), so gates are legitimately green. `uv run ruff format` for consistency. (Improvement-pass.)
- **Cross-story seams exposed:** PY5 query-client is COMPLETE — S1 (neutral read Protocol + specs + result + config + factory + no-op) → S2 (real HTTP backend, all wire vocab `_WIRE_*`-sealed) → S3 (a second structurally-unrelated backend satisfies the same UNMOVED Protocol). Both bars proven with teeth-bearing executable proofs. PY7's example exercises the query snapshot surface; PY8 audits it vs TS E8.

## Follow-up

> PY5 post-close improvement pass, 2026-07-10.

- **Addressed the two cosmetic review suggestions** (test-only, no src change): (S2) renamed the misleading `test_a_completed_status_without_a_status_id_on_first_poll_is_neutral_error` → `test_a_completed_status_missing_its_status_id_is_a_neutral_error` (the guard gives up with 0 poll GETs, so "on first poll" was wrong); (S3) `ruff format` wrapped the single 101-char line in `test_warehouse_query_adapter.py` (formatter consistency; `ruff check` already passed). Gates green (mypy strict 41 · ruff · pytest 323 · neutrality clean).
