# Roadmap — analytics-kit

Last updated: 2026-07-14 — Self-host cycle (E17–E21) **COMPLETE** — all five epics shipped; the full capture→store→query+flags loop runs on the consumer's own Neon with zero PostHog egress, machine-proven end-to-end on live Postgres at TS/Python parity. Ready for `/roadmap promote`.

## Status

Pre-1.0. **Five cycles complete and archived**: the vendor-neutral **`core`** seam, the **R1 targets**
cycle, **Python parity**, **capability completion** (feature-flags + session-replay), and the
**query row contract** cross-tree work. Both language trees live under a polyglot [`ts/`](../ts/) +
[`python/`](../python/) layout and are at capability + read-contract parity; both acceptance bars and
vendor-neutrality are gated as standing checks in each tree. **In flight: the Self-host backend
completion (Neon-native) area** (E17–E21) — the push from nominal to protocol-level vendor-neutrality
(see NOW). Closed cycles archive their epics to [`epics/done/`](epics/done/); the narrative of what each
established lives in [`planning/HISTORY.md`](HISTORY.md).

## Sequencing

NOW holds the epics committed for the current build push; **`/implement-epics all` builds every NOW
epic**, in dependency order driven by each epic's `blocked_by` graph. Epics are the unit of work,
not grouped into area-cycles. Prioritization is measured against the SOTA / `posthog-js`-capability
bar, not consumer pull.

## NOW

### Focus area: Self-host backend completion (Neon-native)

Close the library's vendor-neutrality gap from **nominal** (identifiers de-branded, name scan green) to
**protocol-level**. Today every working data path speaks PostHog's wire (query = HogQL Query API;
capture = PostHog ingest `/batch/`; flags = `/flags/`), and the only implemented backends target a
PostHog-compatible host — the Neon/warehouse query adapter is a typed STUB and nothing writes to Neon.
This cycle makes the **full loop** — capture → store → query (+ flags) — run against a consumer's own
Neon Postgres with **zero HTTP calls to any PostHog host** and **zero consumer code change** vs the
PostHog config. PostHog stays as **one selectable backend** — not the default, not the only one.

Two decisions are baked in: **(1)** warehouse funnel/retention ship correct, well-defined semantics with
conventions **documented** (window-from-step-0; cohort `period_index=0`) — NOT byte-exact HogQL parity
(the consumer is greenfield: no existing PostHog data to match, which also removes any data-backfill
concern); **(2)** scope is the **full loop**, all five epics, at **TS/Python parity**.

- **[E17-ADP-warehouse-substrate](epics/done/E17-ADP-warehouse-substrate.md)** *(done)* — library-owned
  `events` schema + taxonomy-generated typed view + shipped migration; role-named injectable DB-execute
  seam + default driver behind the `warehouse` extra; `warehouse_dsn` config field + presence-based
  factory selection ladder. Froze the schema as `planning/WAREHOUSE-SCHEMA-CONTRACT.md` (the one-way
  door). **Substrate complete — E18/E19 now unblocked.** (Generated view needs Postgres ≥16.)
- **[E18-QRY-warehouse-query-primitives](epics/done/E18-QRY-warehouse-query-primitives.md)** *(done)* — the four
  structured primitives + `raw_query` as SQL over the typed view, each flattening to neutral rows
  **byte-identical to the HTTP adapter's** (bar-A read-side proof, executable vs `query-contract.fixtures`).
  Funnel + retention independently verified on real Postgres 16. **Read side complete — a consumer queries
  their own Neon.**
- **[E19-NODE-ingest-receiver-persistence](epics/done/E19-NODE-ingest-receiver-persistence.md)** *(done)* —
  library-shipped framework-mountable reference receiver (inbound analog of the existing middlewares)
  that parses the existing node batch envelope and idempotent-upserts into the `events` table; Django /
  FastAPI / ASGI + TS Express / Next-route / plain-handler mounts, all over one neutral core + a
  C-symmetric `warehouse_dsn` from-config factory. **Write side complete — capture→store→query runs on
  the consumer's own Neon.**
- **[E20-FF-fully-local-flags](epics/done/E20-FF-fully-local-flags.md)** *(done)* — a **neutral consumer-facing
  `FeatureFlagDefinition` type** (public, structurally neutral — the consumer never authors the raw wire
  shape) + consumer-supplied static definitions seeding the snapshot via a structurally-no-fetch seeded
  poller (evaluator byte-unchanged). **Last remote flag dependency closed — self-host flag eval makes
  provably zero remote calls.** Neon `flag_definitions` table is a deferred additive follow-up.
- **[E21-OBS-protocol-neutrality-gate](epics/done/E21-OBS-protocol-neutrality-gate.md)** *(done)* — the capstone: a
  second, orthogonal (behavioral) neutrality gate — standing factory-selection assertion + end-to-end
  zero-egress acceptance test against real/local Postgres — plus the honest self-host recipe doc. The
  E1 capstone caught 3 real-engine defects the fake-backed tests couldn't (2 driver-conformance + the
  breakdown contract violation), all fixed and re-proven on live PG16. The acceptance bar is now
  machine-proven at TS/Python parity.

**Dependency graph:** `E17 → (E18 ∥ E19 once the schema lands) → E20 → E21`. E17 is the one-way-door
foundation; E18 (read) and E19 (write) parallelize once E17's schema contract is frozen; E20 is
low-risk and slots after; E21 is last by construction — it proves E17–E20 end to end. No build epic
carries a blocking `blocked_by`: the DB-execute seam is injectable (a fake in unit tests), so E17–E20
are buildable/testable without a real Neon; only E21's end-to-end acceptance test needs a real/local
Postgres (test-infra, spun up in CI — see Development prerequisites).

**Exit criteria (the acceptance bar):** a consumer configured for self-host runs the full loop
(capture → store → query + flags) against their own Neon Postgres, making **zero HTTP calls** to any
PostHog host, with **no consumer code change** vs the PostHog config — proven by the E21 end-to-end test
(recording-transport log empty of `/api/projects/.../query/`, `/flags/`, `/batch/`; results provably
from Neon) and the standing factory-selection gate, at TS/Python parity.

## Development prerequisites

Consumer-setup notes for adopting self-host — all **provisioning/config, none a library edit**, and
**none a blocking gate on building** these epics (E17–E20 build and unit-test against an injectable fake
DB-execute seam):

- **A Neon (Postgres) DSN** — the consumer's own warehouse, supplied via the `warehouse_dsn` config
  field.
- **Run the library migration** — the shipped `events`-table DDL (E17), run by the consumer against
  their Neon.
- **Install the driver extra** — the `warehouse` extra / optional peer-dep (`psycopg` v3 Python / `pg`
  node-postgres TS).
- **Author static flag definitions** — the zero-infra self-host flag default (E20).
- **Mount the shipped receiver** — the framework handler (E19), mounted by the consumer; no server
  component written by the consumer.

**Test-infra (E21 only, not a consumer concern):** a real/local Postgres in CI for the end-to-end
zero-egress acceptance test. It gates that test's execution, not the construction of any epic.

## UPCOMING

_Empty._

## LATER

_Empty._

## Cycle history

| Shipped | Closed | Epics |
|---|---|---|
| `core` seam | 2026-07-08 | E1, E2, E3 → [`epics/done/`](epics/done/) |
| `R1 targets` + audit | 2026-07-09 | E4, E5, E6, E7, E8, E9, E10, E11 → [`epics/done/`](epics/done/) |
| `Python parity` | 2026-07-10 | PY1, PY2, PY3, PY4, PY5, PY6, PY7, PY8 → [`epics/done/`](epics/done/) |
| `capability completion` | 2026-07-10 | E12, E13, E14 → [`epics/done/`](epics/done/) |
| `query row contract` | 2026-07-13 | E15, E16 → [`epics/done/`](epics/done/) |

## How to read this file

- **This file is forward-looking — it lists only epics still to build.** A done epic is never left
  here: on close it archives to [`epics/done/`](epics/done/), gets one row in **Cycle history**
  above, and its narrative moves to [`planning/HISTORY.md`](HISTORY.md).
- **NOW** holds every epic committed for the current build push; `/implement-epics all` builds them
  in `blocked_by` dependency order. **UPCOMING / LATER** hold epics not yet committed to a build
  push.
- **Epics are the unit of work.** No version numbers appear here — versions are git tags, not
  planning labels. Epic links point to `epics/<id>.md` (closed epics live under `epics/done/`);
  stories live under `stories/1-backlog/ … 5-done/`.
- **Promotion** (NOW↔UPCOMING↔LATER) and re-sequencing are user-driven via `/roadmap`; per-epic
  execution runs through `/implement-epics`.
