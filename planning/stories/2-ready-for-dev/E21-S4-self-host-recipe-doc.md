---
id: E21-S4-self-host-recipe-doc
epic: E21-OBS-protocol-neutrality-gate
status: ready-for-dev
area: observability
touches: [adapters, query, node, feature-flags]
depends_on: [E21-S3-e2e-zero-egress-acceptance-test, E21-S5-warehouse-breakdown-fix]
api_impact: additive
---

# E21-S4-self-host-recipe-doc — self-host recipe doc

## Why

A consumer adopting self-host needs the provider-swap walkthrough, with the external prerequisites
named honestly (it is provisioning/config, not "config-only magic"). This ships the recipe that the
now-working loop (S3) documents — the human-facing complement to the machine gates.

## Scope

### In

- A **self-host recipe doc** (the provider-swap walkthrough) covering the full stand-up, at TS/Python
  parity — authored as a **new section in `ts/README.md` + a parity section in `python/README.md`**
  (the shipped E11-S2 README-section convention; see the Technical note "Where the doc lives"):
  - Run the E17 migration (the shipped `events`-table + typed-view DDL) against the consumer's Neon.
  - Supply `warehouse_dsn` / `warehouseDsn` (the DSN config field) — the single self-host signal that
    selects the warehouse query adapter + the DSN-backed receiver.
  - Install the `warehouse` driver extra (`analytics-kit[warehouse]` / the `pg` peer-dep).
  - Author E20 static flag definitions (the zero-infra local-only flag default).
  - Mount the E19 receiver (the framework handler).
- Name the external dev-prerequisites **honestly** — a Neon DSN, running the migration, installing the
  driver extra, authoring static flags, mounting the receiver — as provisioning/config, NOT
  "config-only magic". State the **PG ≥16 floor** in the honest prerequisites (a PG15 consumer gets a
  view that errors at creation).
- Frame PostHog as **ONE selectable backend** — not the default, not the only one.
- State that the self-host config uses the **same taxonomy, identity, allowlist, and events** as the
  PostHog config, with **zero consumer code change** (Bar A / Bar B end-to-end).
- Carry the query-time expectation note: `text→timestamptz` casts are session-`DateStyle`/`TimeZone`-
  dependent for ambiguous inputs (inherent to the cast, not a defect); and the retention breakdown
  groups per `(distinct_id, cohort_bucket, value)`.

### Out

- The gates and the end-to-end test — E21-S2 / E21-S3 (this story documents; it does not build or
  test the loop).
- A dashboard / visualization of the loop — consumer territory.
- A vendor-to-Neon data migration — the target consumer is greenfield (no existing PostHog data);
  the recipe covers a fresh self-host stand-up only.
- Deployment tooling / infra provisioning scripts — consumer territory; the recipe names the
  prerequisites, it does not automate them.

## Acceptance criteria

- [ ] The recipe walks the full self-host stand-up: migration → `warehouse_dsn` → driver extra →
      static flags → receiver mount, at TS/Python parity — as a section in `ts/README.md` and a
      parity section in `python/README.md`.
- [ ] The TS recipe section passes `pnpm neutrality-scan` (the README is a scanned doc target):
      PostHog named only by neutral role, zero vendor/hostname/`$`-literal tokens; the Python parity
      section is equally clean under the Python scan analog.
- [ ] External prerequisites are named honestly (provisioning/config, not "config-only"), including
      the **PG ≥16 floor**.
- [ ] PostHog is framed as one selectable backend, not the default and not the only one.
- [ ] The recipe states: same taxonomy/identity/allowlist/events as the PostHog config, zero consumer
      code change (Bar A + Bar B).
- [ ] The cast/DateStyle and retention-breakdown-grouping notes are documented as query-time
      expectations.

## Technical notes

Locked by the epic `## Success criteria` (the recipe), `## Development prerequisites` (the honest
prerequisites + PG ≥16 floor + cast caveat), and `## Notes` (F — honest external dev-prerequisites).

- **Now depends on E21-S5 as well as E21-S3 (re-sequenced 2026-07-14).** The E1 capstone surfaced
  Defect 3 — the warehouse breakdown builders targeted a non-existent raw `properties` column, so
  every breakdown query failed on real Postgres. E21-S5 fixes it (breakdown groups on the declared
  typed view column). This recipe is sequenced AFTER S5 so it documents WORKING breakdown, not a known
  limitation. New graph: `(S1 ∥ S2) → S3 → S5 → S4`. If the recipe illustrates a broken-down query,
  it reflects S5's declared-typed-column semantics: **breakdown keys must be declared event
  properties** (an undeclared breakdown key raises at query build time) — state this honestly in the
  recipe if breakdown is shown. — PM (2026-07-14) + architect (2026-07-14, via E21-S5)

- **Honest, not "config-only."** The epic locks: the recipe names, honestly, a Neon DSN, running the
  migration, installing the driver extra, authoring static flags, mounting the receiver. All
  provisioning/config — none a library edit — but do NOT over-claim "config-only magic." — architect
  (2026-07-13, epic Notes F)
- **The config surface the recipe documents.** Query `warehouse_dsn` / `warehouseDsn`
  (`python/src/analytics_kit/query/factory.py:25` / `ts/packages/node/src/query/create-query-client.ts:8`);
  receiver `create_receiver_from_config` / `createReceiverFromConfig`
  (`python/src/analytics_kit/receiver/factory.py:31` / `ts/packages/node/src/receiver/create-receiver-from-config.ts:33`);
  flags `static_definitions` + `only_evaluate_locally` / `staticDefinitions` + `onlyEvaluateLocally`
  (`python/src/analytics_kit/flags/factory.py:37` / `ts/packages/node/src/flags/create-flag-client.ts:33`);
  migration `build_migration_sql` / `buildMigrationSql`
  (`python/src/analytics_kit/query/warehouse_schema.py:138` / `ts/packages/node/src/query/warehouse-schema.ts:125`).
  Driver extra: `analytics-kit[warehouse]` (Python, `psycopg` v3) / the `pg` node-postgres peer-dep (TS).
- **PG ≥16 floor is a stated prerequisite.** The `events_typed` view uses `pg_input_is_valid` (PG16);
  a PG15 consumer gets a view that errors at creation. State the floor honestly. Neon runs 16/17/18,
  so the greenfield target is fine. — epic Development prerequisites (E17-S2 review, 2026-07-14)
- **Query-time expectation notes to carry.** `text→timestamptz` casts are session-`DateStyle`/
  `TimeZone`-dependent for ambiguous inputs (inherent to the cast — a query-time expectation, never an
  error/defect); the retention breakdown groups per `(distinct_id, cohort_bucket, value)`, so an actor
  with two breakdown values in a cohort week lands in two breakdown cohorts. — epic Development
  prerequisites + E18 follow-ups
- **Where the doc lives — PINNED to the README-section precedent (verified 2026-07-14).** The repo's
  recipe/guide convention is a **README section**, not a `planning/` doc: the shipped
  `E11-S2-adopt-in-new-app-guide` landed its "Adopt in a new app" walkthrough as an appended section
  in the README (see its `## Shipped`). So the self-host recipe is a **new section in `ts/README.md`
  and a parity section in `python/README.md`** (both exist today: `ts/README.md`, `python/README.md`).
  Do NOT put it in a `planning/` doc — that breaks the established convention and the reader's
  expected home.
- **The README recipe IS neutrality-scanned — it MUST read vendor-clean, not merely "should"
  (correction, verified 2026-07-14).** The TS neutrality scan reads the README as a doc target:
  `scanRepo` (`ts/scripts/neutrality-scan.ts:424`) runs `scanDoc` over `readmePath` (+ any
  `extraDocPaths`), and the real gate wires `readmePath = ts/README.md`
  (`ts/scripts/neutrality-scan.test.ts:20`). So the TS recipe section landing in `ts/README.md` is
  scanned by `pnpm neutrality-scan` — zero `posthog`/vendor-hostname/`$`-literal tokens, PostHog
  named ONLY by neutral role. (Python has its own scan analog, `python/scripts/neutrality_scan.py` —
  the Python recipe in `python/README.md` must be equally clean.) IF the recipe is instead authored
  as a SEPARATE README-adjacent file rather than folded into `ts/README.md`, it MUST be registered in
  the scan's `extraDocPaths` (the code at `neutrality-scan.ts:405` anticipates exactly this: "Extra
  shipped docs … land as more README-adjacent files; add them here and they pass the SAME doc gate")
  — otherwise it silently escapes the neutrality gate. This is a documentation-only story (no
  src/tests change), but the doc IS gated. — story-refiner (2026-07-14)

## Shipped

<!-- Filled by /implement-epics on move to 5-done. -->
