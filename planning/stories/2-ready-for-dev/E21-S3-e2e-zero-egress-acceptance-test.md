---
id: E21-S3-e2e-zero-egress-acceptance-test
epic: E21-OBS-protocol-neutrality-gate
status: ready-for-dev
area: observability
touches: [adapters, query, node, feature-flags]
depends_on: [E21-S1-python-driver-write-path-fix]
api_impact: additive
---

# E21-S3-e2e-zero-egress-acceptance-test — E1 end-to-end zero-egress acceptance test

## Why

This is the capstone proof of the whole self-host cycle: the full loop (capture → store → query +
flags) running against a **real** Postgres with **zero HTTP egress** to any PostHog host and results
**provably from Neon**. It machine-checks E17–E20 end to end — the one place the funnel/retention
counts get verified against a real SQL engine, not a fake.

## Scope

### In

- A **per-tree "needs-Postgres" test tier** that the fast inner loop deselects and CI opts into:
  - **Python**: register a `needs_postgres` pytest marker in `python/pyproject.toml`
    `[tool.pytest.ini_options]` and extend `addopts` to
    `-m 'not artifact_scan and not needs_postgres'`; decorate the E1 test (and the S1 real-driver
    write test) `@pytest.mark.needs_postgres` + a `skipif(DATABASE_URL is None)` safety net.
  - **TS**: wrap the E1 suite in `describe.skipIf(!process.env.DATABASE_URL)` colocated under
    `ts/packages/node/src`; it folds into the existing `test` turbo task — **no new vitest project,
    no new turbo task**.
- The **end-to-end acceptance test** driving the full loop against a real Postgres (≥16), in both
  trees at parity:
  1. Run the E17 migration (`build_migration_sql` / `buildMigrationSql`) into a throwaway DB/schema.
  2. POST a capture batch through the E19 receiver core (`create_receiver_from_config` /
     `createReceiverFromConfig` from the DSN) → the `events` table; assert rows landed and re-POST is
     idempotent (`ON CONFLICT (uuid) DO NOTHING`).
  3. Run all four E18 primitives + `raw_query` via the warehouse-selected query client
     (`create_query_client` / `createQueryClient`), including **at least one funnel + one retention
     adversarial scenario over real data**, asserting the returned neutral-row counts equal the
     hand-computed expected counts (count-faithfulness — the thing the fake-backed E18-S2/S3 tests
     cannot prove).
  4. Evaluate E20 static flags via a local-only client (`static_definitions` /`staticDefinitions` +
     `only_evaluate_locally` / `onlyEvaluateLocally`), asserting zero definition/flag fetches.
  5. Wrap the HTTP-capable seams (`QueryTransport` / `FetchLike`, and the flag transport) in a
     **recording transport** and assert its log is **EMPTY** of `/api/projects/.../query/`,
     `/flags/`, and `/batch/` — i.e. no PostHog-shaped path was ever contacted (the HTTP adapters are
     never even constructed) — AND that the queried rows are the ones the receiver wrote
     (results-provably-from-Neon).
- **Provision the throwaway Postgres** for the test: dev — `docker run --rm postgres:16` (fresh
  schema/DB per run). PG **≥16** floor (the E17-S2 `pg_input_is_valid` view). **The E1 test is PROVEN
  in this story against a local Docker `postgres:16`**, and left CI-ready via the needs-Postgres tier
  (the marker / `skipIf` + the turbo `env` cache-key). **Do NOT author a CI workflow in this story** —
  RESOLVED (user, 2026-07-14): option (a), proven-locally + marker-gated, no new CI pipeline this cycle.
  Authoring the project's first push/PR test-gate workflow (with a `services: postgres:16` job) is a
  DEFERRED follow-up — recorded, not built here.

### Out

- The self-host recipe doc — E21-S4 (this story makes the loop run; S4 documents it).
- The fast selection gate — E21-S2 (this is the executing proof; S2 is the fast selection proof).
- A multi-version Postgres matrix (16 proves the floor; 17/18 is expansion-path, not now).
- Any migration framework, seed-fixtures library, or bespoke CI harness — use the native
  `services:` block and the shipped migration string. Port only what's needed.

## Acceptance criteria

- [ ] The needs-Postgres tier is deselected in the fast inner loop (`cd python && uv run pytest`;
      `cd ts && pnpm turbo run test`) with `DATABASE_URL` unset, and RUNS when opted into
      (`uv run pytest -m needs_postgres` / a `DATABASE_URL`-set `turbo run test`) — **PROVEN in this
      story against a local Docker `postgres:16`**, in both trees, symmetrically. (Authoring a CI
      workflow to run it on push/PR is a DEFERRED follow-up per the user decision — the tier is
      CI-ready; the pipeline is not built here.)
- [ ] The E1 test runs the full loop end-to-end against a real Postgres ≥16: migrate → capture via
      the receiver → query → evaluate flags — with no manual steps.
- [ ] The recording-transport log is asserted EMPTY of `/api/projects/.../query/`, `/flags/`,
      `/batch/` — the HTTP query/flag adapters are never constructed under the self-host config.
- [ ] Results are provably from Neon: the funnel + retention counts equal the counts seeded through
      the receiver; at least one funnel and one retention adversarial scenario are machine-checked.
- [ ] Idempotency holds: re-POSTing the same batch leaves the `events` count unchanged.
- [ ] Depends on E21-S1 — the Python real-driver write path returns the empty result on the
      receiver's non-RETURNING write instead of raising.
- [ ] TS/Python parity on the loop and the tier; PG ≥16 provisioned in both dev and CI.

## Technical notes

Locked by the epic `## Success criteria` (E1), `## Development prerequisites`, and `## Notes` (E1 +
F). The full test-integration design is the architect consult below — pin it verbatim.

- **Needs-Postgres tier — the symmetric mechanism.** Python extends the confirmed `artifact_scan`
  precedent (`python/pyproject.toml:61-64`: `markers = [...]`, `addopts = "-m 'not artifact_scan'"`).
  Add a `needs_postgres` marker to the same `markers` list and extend `addopts` to
  `-m 'not artifact_scan and not needs_postgres'`; CI runs the tier with `uv run pytest -m
  needs_postgres`. Add a `skipif(DATABASE_URL is None)` safety net so a mis-run skips rather than
  errors. TS uses `describe.skipIf(!process.env.DATABASE_URL)` colocated in `ts/packages/node/src`,
  folded into the existing `test` turbo task — NOT a new vitest project (the repo's root
  `ts/vitest.config.ts` deliberately defines no `projects`/`workspace`; each package owns a flat
  `packages/*/vitest.config.ts`) and NOT a new turbo task. Both reach the same end state: deselected
  locally, runs in CI. — architect (2026-07-14)
- **REQUIRED TS cache-key fix — `describe.skipIf` alone is NOT enough (verified 2026-07-14).** The
  `test` turbo task (`ts/turbo.json:18-20`) currently declares only `dependsOn: ["^build"]` — no
  `env`, and `DATABASE_URL` is in no `globalDependencies`/`globalEnv`. Two consequences the builder
  MUST fix or the tier silently false-greens: (1) turbo runs tasks in a sanitized env, so
  `DATABASE_URL` is not even passed through to the vitest child unless declared; (2) `DATABASE_URL`
  is not in the cache key, so an inner-loop run (unset ⇒ suite skipped ⇒ green result CACHED) is
  served STALE to a CI run (set ⇒ same package inputs ⇒ turbo replays the skipped cache and the
  Postgres suite NEVER runs). The one-line fix, in `ts/turbo.json`, is to give the `test` task
  `env: ["DATABASE_URL"]` — this both passes the var through AND cache-keys on it, so unset-run and
  set-run hash to different entries. Prefer this over `--force` (which defeats the whole fast loop's
  cache) or a new turbo task (unnecessary). NOTE: `ts/turbo.json` is a repo config file, so this edit
  is the BUILDER's to make in-code — called out here as a required implementation step. — architect
  (2026-07-14) + story-refiner
- **Python needs-Postgres tier is symmetric and clean (verified).** The `python/pyproject.toml`
  `[tool.pytest.ini_options]` marker/`addopts` precedent (`artifact_scan` at lines 61-64) extends
  exactly as drafted: add `needs_postgres` to the `markers` list, extend `addopts` to
  `-m 'not artifact_scan and not needs_postgres'`, CI runs `uv run pytest -m needs_postgres`. No
  toolchain wrinkle on the Python side. — story-refiner (2026-07-14)
- **End-to-end loop wiring — the seams each step drives (both trees).**
  (a) migration: `build_migration_sql(taxonomy)` (`python/src/analytics_kit/query/warehouse_schema.py:138`) /
  `buildMigrationSql(taxonomy)` (`ts/packages/node/src/query/warehouse-schema.ts:125`) — a string; the
  test executes it (this step requires PG ≥16 for the `events_typed` view's `pg_input_is_valid`
  safe-cast).
  (b) receiver write: `create_receiver_from_config(ReceiverConfig(warehouse_dsn=...))`
  (`python/src/analytics_kit/receiver/factory.py:31`; write site `receiver/receiver.py:222` via
  `_build_upsert`) / `createReceiverFromConfig({ warehouseDsn })`
  (`ts/packages/node/src/receiver/create-receiver-from-config.ts:33`; write site `receiver.ts:107-108`).
  This is the exact non-RETURNING write that triggers the S1 MUST-FIX. Envelope shape
  `{ api_key, batch: WireEvent[], sent_at }`, `WireEvent { uuid, event, distinct_id, properties?, timestamp? }`.
  (c) query: `create_query_client(QueryClientConfig(warehouse_dsn=..., taxonomy=...))`
  (`python/src/analytics_kit/query/factory.py:25`, warehouse rung) / `createQueryClient({ warehouseDsn, taxonomy })`
  (`ts/packages/node/src/query/create-query-client.ts:8`, `warehouseDsn !== undefined` rung).
  (d) flags: `create_flag_client(FlagClientConfig(key=..., static_definitions=[...], only_evaluate_locally=True))`
  (`python/src/analytics_kit/flags/factory.py:37`, static branch line 78) /
  `createFlagClient({ key, staticDefinitions, onlyEvaluateLocally: true })`
  (`ts/packages/node/src/flags/create-flag-client.ts:33`, static branch line 85-105).
  (e) recording transport: `QueryTransport` via `QueryClientConfig.transport`
  (`python/src/analytics_kit/query/config.py:48`) and `FlagClientConfig.transport`; `FetchLike` via
  `QueryClientConfig.fetch` (`ts/packages/node/src/query/config.ts:19`) and `FlagClientConfig.fetch`.
  The receiver has NO outbound HTTP (its egress is the DSN), so its neutrality is proven by the query
  round-trip, not a fetch log. — architect (2026-07-14)
- **The assertion is two-sided — that duality IS the proof.** (1) Selection proof (strong form): the
  warehouse/local-only rungs win ahead of the HTTP rungs, so the recording transport is never
  reached AT ALL — the log is empty because no HTTP-capable adapter was constructed, not merely
  because URLs didn't match. (2) Provenance proof: the funnel/retention/trend counts equal the counts
  seeded via the receiver — the data round-tripped through the consumer's own Postgres. This is why
  the epic rejected an AST scan. — architect (2026-07-14)
- **Count-faithfulness is new here.** E18-S2/S3 tests are fake-backed — they pin SQL SHAPE and
  parity-by-mirror, NOT count-faithfulness against a real engine. E1 is where the funnel
  window-from-step-0 and retention `period_index=0`-is-cohort's-own-period semantics get machine-checked
  on real Postgres. Seed known funnel outcomes (out-of-order, boundary, partial completion) and a
  known retention grid; assert the returned neutral rows equal the hand-computed counts. — architect (2026-07-14)
- **Provisioning.** Dev: `docker run --rm -d --name akit-e21-pg -e POSTGRES_PASSWORD=postgres -p
  5432:5432 postgres:16` (Docker 27.4.0 confirmed reachable on this machine; `psql` client 18.1, no
  local server binary — a container is correct). Use a fresh schema/DB per run
  (`CREATE SCHEMA e21_<runid>` or `CREATE DATABASE`), migrate into it, drop at teardown — the `events`
  DDL is `CREATE TABLE IF NOT EXISTS`, so a fresh namespace avoids cross-run row bleed into count
  assertions. CI: GitHub Actions `services: postgres:16` with `--health-cmd pg_isready`, `DATABASE_URL`
  in the job env (and, TS-side, exported into the `turbo run test` step so the `env: ["DATABASE_URL"]`
  cache-key sees it). Pin `postgres:16` (the floor); no multi-version matrix. — architect (2026-07-14)
- **CI-workflow packaging is BIGGER than "a builder call" — there is no test-gate workflow today
  (verified 2026-07-14).** `.github/workflows/` contains ONLY `release-ts.yml`, a tag-triggered
  (`ts-v*`) publisher with `working-directory: ts` — NOT a push/PR gate, and there is NO Python CI
  workflow at all. So "add the Postgres job to an existing gate workflow" is not a real option: the
  only homes are (a) author the project's FIRST push/PR test-gate workflow (pnpm/turbo setup + the
  four TS gates + `uv run pytest`, then the `services: postgres:16` needs-Postgres job on top), or
  (b) bolt Postgres onto the release publisher — which is wrong (release runs on tag, not on the PR
  that would introduce the regression this tier catches). The needs-Postgres TIER MECHANISM (marker
  + addopts; `skipIf` + `env` cache-key) is self-contained and builder-implementable as scoped here.
  But "runs in CI" presumes a test-gate workflow that does not exist — standing that up is net-new CI
  infrastructure. This crosses the refine/redesign line, so it was FLAGGED for user input. **RESOLVED
  (user, 2026-07-14): option (a) — proven-locally + marker-gated. S3 does NOT author a CI workflow; the
  needs-Postgres tier is left CI-ready and the E1 test is PROVEN against a local Docker `postgres:16`.
  Standing up the project's first push/PR test-gate CI workflow (with a `services: postgres:16` job) is
  a DEFERRED follow-up — recorded, not this cycle — consistent with the zero-extra-infra posture.** —
  architect (2026-07-14) + story-refiner; user-resolved 2026-07-14
- **PG ≥16 floor + cast caveat (carry-over notes).** The generated `events_typed` view uses
  `pg_input_is_valid` (PG16) — a PG15 consumer gets a view that errors at creation, so E1 provisions
  ≥16 (and the S4 recipe states the floor). Carry a note that `text→timestamptz` casts are
  session-`DateStyle`/`TimeZone`-dependent for ambiguous inputs — a query-time expectation, not a
  defect. The retention breakdown groups per `(distinct_id, cohort_bucket, value)` (an actor with two
  breakdown values in a cohort week lands in two breakdown cohorts) — assert accordingly in the
  retention scenario. — epic Development prerequisites + E18 follow-ups
- **Cross-story marker handoff (S1 ↔ S3).** S1's real-driver write test is DECORATED with
  `@pytest.mark.needs_postgres` but S3 REGISTERS that marker in `python/pyproject.toml` and extends
  `addopts`. Sequence: `(S1 ∥ S2) → S3 → S4`. If S1 lands ahead of S3, S1 gates its test with
  `skipif(DATABASE_URL is None)` alone (inert until S3 wires the marker), and S3 finalizes the marker
  registration + provisions the Postgres both tests need. S3 does NOT depend on S2 (S2 is the fast
  standing selection gate — orthogonal, no shared artifact). Confirmed sound: S1 `depends_on: []`,
  S2 `depends_on: []`, S3 `depends_on: [E21-S1]`, S4 `depends_on: [E21-S3]`. — story-refiner (2026-07-14)
- **Vendor-neutral scope.** This is test-infra + the S1 driver fix only; it exercises and asserts the
  already-frozen E17–E20 seams and changes nothing a consumer observes. — architect (2026-07-14)

## Shipped

<!-- Filled by /implement-epics on move to 5-done. -->
