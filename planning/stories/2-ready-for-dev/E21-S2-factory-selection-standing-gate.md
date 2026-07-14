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

## Shipped

<!-- Filled by /implement-epics on move to 5-done. -->
