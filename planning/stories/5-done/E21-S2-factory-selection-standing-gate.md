---
id: E21-S2-factory-selection-standing-gate
epic: E21-OBS-protocol-neutrality-gate
status: ready-for-dev
area: observability
touches: [adapters, query, node, feature-flags]
depends_on: []
api_impact: additive
---

# E21-S2-factory-selection-standing-gate — E2 standing factory-selection gate

## Why

The name scan proves observability (nominal) neutrality; nothing yet proves a self-host config
*selects* the neutral backends rather than a PostHog-wire one. This adds the standing behavioral gate:
given a self-host config, assert the right adapter/client is selected — fast, no real Postgres, run
in the quality set in both trees.

## Scope

### In

- A **fast integration test** (added to the standing quality set, TS + Python parity) that, given a
  self-host config, asserts at the **selection level**:
  - `create_query_client` / `createQueryClient` returns the `WarehouseQueryAdapter` (the warehouse
    rung), **NOT** the HTTP query adapter.
  - The flag client built from static definitions is **local-only** — seeded from
    `static_definitions` / `staticDefinitions` with `only_evaluate_locally` / `onlyEvaluateLocally`,
    and has **no flag/definitions URL** (structurally cannot fetch).
  - The receiver's from-config factory (`create_receiver_from_config` / `createReceiverFromConfig`)
    targets the DSN — builds a DSN-backed `DbExecute`, not an HTTP writer.
- Assertions are **selection-level and robust** (which adapter/client the config constructs), NOT
  URL-string matching. Use the injectable seam already used across the trees (a fake `DbExecute` /
  fake transport) so no real Postgres and no network are needed.
- Wire it into the quality set so it runs in the fast inner loop (it is fast — no DB, no net).

**What this story actually IS (refinement, 2026-07-14).** The three selection assertions this gate
makes ALREADY EXIST as green per-capability tests in both trees (see the "existing coverage" note
below). S2 is therefore a **consolidation**, not a from-scratch build: gather the three postures into
ONE named `self-host-selection` gate that runs together as a standing behavioral unit in the quality
set, so a future regression in ANY rung fails one clearly-named gate rather than being spread across
three per-capability suites. Reuse the existing assertion mechanics; do NOT duplicate the existing
per-capability tests wholesale. Sizing is SMALL-to-MEDIUM — mostly assembly + naming, not new proof
mechanics. Parity: TS and Python each get the same consolidated gate.

### Out

- The end-to-end zero-egress loop against a real Postgres — E21-S3 (this gate is the fast selection
  proof; S3 is the executing proof).
- Any AST-based protocol scan — **REJECTED** by the epic; selection-level assertions are the chosen
  mechanism.
- Weakening or replacing the name-based neutrality scan — this gate is orthogonal and additive.

## Acceptance criteria

- [ ] Given a self-host query config (`warehouse_dsn` / `warehouseDsn` present), the factory returns
      the warehouse adapter, not the HTTP adapter — asserted by construction, not by URL string.
- [ ] Given a static-definitions flag config, the built client is local-only with no flag/definitions
      URL and cannot fetch.
- [ ] Given a self-host receiver config, the from-config factory builds a DSN-targeted writer (a
      DSN-built `DbExecute`), not an HTTP writer.
- [ ] The gate is fast (no real Postgres, no network — uses the injectable fake seam) and runs in the
      standing quality set in BOTH trees at parity.
- [ ] Bar A / Bar B framing holds: the same config selects the neutral self-host backends with zero
      consumer code change vs the PostHog config.

## Technical notes

Locked by the epic `## Success criteria` (E2) and `## Notes` (E — the second, orthogonal gate);
selection ladders and entry points confirmed against the shipped src.

- **Query selection ladder — the warehouse rung wins by field presence.** Python:
  `create_query_client` (`python/src/analytics_kit/query/factory.py:25`) — `config.warehouse_dsn is not
  None` ⇒ `create_warehouse_query_adapter_from_config` (line 33-34), the first rung, ahead of the
  personal-key/HTTP ladder. TS: `createQueryClient`
  (`ts/packages/node/src/query/create-query-client.ts:8`) — `config.warehouseDsn !== undefined` ⇒
  `createWarehouseQueryAdapterFromConfig` (line 21-25), ahead of the personalKey ladder. Assert the
  RETURNED client is the warehouse adapter (selection-level), not by inspecting URLs.
- **Flags selection.** Python: `create_flag_client` (`python/src/analytics_kit/flags/factory.py:37`) —
  the `config.static_definitions is not None` branch (line 78) seeds `DefinitionPoller.seeded(...)`
  with no endpoint/credential/transport; `only_evaluate_locally` → `only_locally` (line 77). TS:
  `createFlagClient` (`ts/packages/node/src/flags/create-flag-client.ts:33`) — the `staticDefinitions
  !== undefined` branch (line 85-105) → `DefinitionPoller.seeded(...)`, `onlyLocally:
  config.onlyEvaluateLocally ?? false` (line 103). Assert the built client is local-only and holds no
  flag/definitions URL.
- **Receiver selection.** Python: `create_receiver_from_config`
  (`python/src/analytics_kit/receiver/factory.py:31`) — `warehouse_dsn` present ⇒
  `Receiver(create_default_db_execute(config.warehouse_dsn))` (line 48); absent ⇒ a clear neutral
  error (write side has no natural empty-success state). TS: `createReceiverFromConfig`
  (`ts/packages/node/src/receiver/create-receiver-from-config.ts:33`) — reads `warehouseDsn`, builds
  the default `DbExecute`. Assert the factory targets the DSN (selection-level); the existing
  `create-receiver-from-config.test.ts` already asserts `defaultDbExecuteMock` was called with the
  DSN — this gate consolidates that posture as a standing behavioral check.
- **Why selection-level, not URL-string / AST.** The epic locks: selection-level assertions are robust
  where URL-string matching (and an AST protocol scan — REJECTED) are brittle. The strongest form is
  "the HTTP adapter was never even constructed" — assert the returned type, not what URL a
  never-constructed adapter would have used. — architect (2026-07-13, epic Notes)
- **Injectable seam.** No real Postgres, no network — use the fake `DbExecute` / fake transport
  already used across the trees (Python `python/tests/db_execute_fakes.py`; TS the `defaultDbExecuteMock`
  pattern in the existing receiver-from-config test). — architect (2026-07-14)
- **LOAD-BEARING: the TS↔Python driver-import asymmetry — the query rung is NOT symmetric to build.**
  Verified against src (story-refiner, 2026-07-14). The two trees differ in WHEN the default driver
  loads its dependency, and the Python selection test MUST account for it or it will raise, not assert:
  - **TS is LAZY.** `createDefaultDbExecute` (`default-db-execute.ts:61-73`) returns an async closure;
    the `pg` peer is imported only on first `execute` call. So `createQueryClient({ warehouseDsn })`
    CONSTRUCTS the `WarehouseQueryAdapter` clean with NO `pg` installed. The TS query selection assert
    is trivially `expect(client).toBeInstanceOf(WarehouseQueryAdapter)` with a fake DSN and NO mock —
    exactly as `create-query-client.test.ts:189,208` already does.
  - **Python is EAGER.** `DefaultDbExecute.__init__` (`default_db_execute.py:61-64`) checks
    `_WAREHOUSE_DRIVER_AVAILABLE` and **raises `RuntimeError(_DRIVER_MISSING)` at construction** if
    `psycopg` is absent — and the dev env has NO `warehouse` extra (`_WAREHOUSE_DRIVER_AVAILABLE is
    False`, asserted by `test_receiver_from_config.py:177`). So `create_query_client(config_with_
    warehouse_dsn)` will RAISE unless the test **monkeypatches `create_default_db_execute` at the
    driver-build boundary**: `monkeypatch.setattr("analytics_kit.query.warehouse_adapter.create_default_db_execute", lambda _dsn: fake)`
    for the query rung, and `"analytics_kit.receiver.factory.create_default_db_execute"` for the
    receiver. This is the exact pattern the shipped tests use (`test_query_client.py:404-410`,
    `test_receiver_from_config.py:27-33`). Without this monkeypatch the Python gate does not assert —
    it errors. Pin it so the builder does not write the raising form. — story-refiner (2026-07-14)
- **Existing coverage the gate consolidates (all green today, verified 2026-07-14).** (1) Query
  warehouse rung: `test_query_client.py:413` `test_warehouse_dsn_present_selects_the_warehouse_adapter_first_rung`
  / `create-query-client.test.ts:189`. (2) Receiver DSN target: `test_receiver_from_config.py:89`
  `test_from_config_reads_the_dsn_and_builds_the_default_driver` / `create-receiver-from-config.test.ts:60`
  (`defaultDbExecuteMock` called with `{ warehouseDsn }`). (3) Flag static-defs local-only + zero
  fetch: `test_flag_static_definitions.py:134` `test_zero_egress_transport_is_never_called` /
  `static-definitions.test.ts:97` (the injected fetch is NEVER called — no `/flags/`, no definitions
  GET, no URL). The gate's job is to name and co-locate these three as one standing behavioral check,
  not to re-derive them. — story-refiner (2026-07-14)

> Reviewer suggestion (2026-07-14) → E21 improvement pass (comment precision): the TS gate comment
> ("still exercises the genuine lazy driver") overstates it — the `instanceof` proof holds because
> construction is DRIVER-AGNOSTIC (the lazy driver is never invoked at build time), not because the real
> driver runs. Soften the comment to state that invariant.
> Reviewer suggestion (2026-07-14) → E21 improvement pass (parity bookkeeping): the flags-rung transport
> double differs in strength (Python `_RecordingTransport` RAISES on any egress; TS spy asserts
> `not.toHaveBeenCalled()`). Both valid; align if strict parity is wanted.
> Reviewer suggestion (2026-07-14) → E21 improvement pass (cosmetic): TS precedence rung uses
> `personalKey:'pk_read'`, Python `personal_key='phx_read'` — align the dummy token if strict cross-tree
> string parity is a goal (no neutrality/correctness impact; both are never-reached dummies).

## Shipped

> Captured by `implement-epics` on 2026-07-14.

- **Files added:** `ts/packages/node/src/self-host-selection.test.ts`, `python/tests/test_self_host_selection.py` (test-only — the named `self-host-selection` standing gate)
- **New public API:** none — a standing behavioral-neutrality gate in the fast quality set
- **Tests added:** 4 per tree — query warehouse-rung selection (`instanceof WarehouseQueryAdapter`, not HTTP/Noop) + precedence (DSN wins over a full HTTP config, `warn` never called), flags static-defs local-only + zero-egress (real `evaluate`, transport never called), receiver DSN-build-boundary target — all fast (fake seam, NO Postgres/network), run in the default `pnpm turbo run test` / `uv run pytest`
- **Commit:** this story's ship commit on `main` (see `git log`)
- **Reviewer notes:** independent gate verdict SHIP (no criticals) — assertions genuinely selection-level (never URL/AST); the TS-lazy/Python-eager driver asymmetry handled right (Python monkeypatches the driver-build boundary → asserts not errors; no mock leaks into the TS query `instanceof`); flags zero-egress proven behaviorally without touching privates; the three source tests left in place (consolidation, not duplication). 3 cosmetic suggestions above
- **Cross-story seams exposed:** **the standing behavioral-neutrality gate is live** — the name scan proves observability neutrality; this proves BEHAVIORAL neutrality (a self-host config SELECTS the neutral backends: warehouse query adapter, local-only flags with no URL, DSN-built receiver — the HTTP adapters are never even constructed). Complements, doesn't replace, `neutrality-scan`. **S3** is the EXECUTING proof (the same selections driven end-to-end against real Postgres with a zero-egress log). `phx_read`/`pk_read` are test-only dummy HTTP credentials proving the warehouse rung wins even alongside a full HTTP config.
