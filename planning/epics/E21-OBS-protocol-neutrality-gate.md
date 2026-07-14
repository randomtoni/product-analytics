---
id: E21-OBS-protocol-neutrality-gate
status: active
area: observability
touches: [adapters, query, node, feature-flags]
api_impact: additive
blocked_by: []
updated: 2026-07-14
---

# E21-OBS-protocol-neutrality-gate — Protocol-neutrality gate + self-host acceptance recipe

## Why

The name scan proves **observability** neutrality (no vendor identifier reaches a consumer) but says
nothing about **behavioral** neutrality — a self-host config could still silently speak PostHog's wire.
This capstone epic adds a SECOND, orthogonal gate that proves the protocol is neutral, and ships the
consumer-facing recipe that walks a consumer through the full self-host loop. It proves the cycle's
acceptance bar: capture → store → query (+ flags) against the consumer's own Neon, ZERO HTTP calls to
any PostHog host, ZERO consumer code change vs the PostHog config. It is the capstone by construction —
it validates E17–E20 end to end.

## Success criteria

- **E2 — standing factory-selection gate** (added to the quality set alongside the neutrality scan):
  given a self-host config, assert `create_query_client`/`createQueryClient` returns the
  `WarehouseQueryAdapter` (NOT the HTTP adapter), the flag client is local-only with no flag URL, and
  the receiver writer targets the DSN. Selection-level assertions (robust) rather than URL-string
  matching (brittle). Kept as a **fast integration test, NOT an AST pass.**
- **E1 — end-to-end zero-egress acceptance test:** the full self-host loop against a **real/local
  Postgres**, asserting zero HTTP egress — a recording transport whose log is EMPTY of
  `/api/projects/.../query/`, `/flags/`, and `/batch/` — AND results provably from Neon.
- The **self-host recipe doc:** the provider-swap walkthrough — run the E17 migration, supply the
  `warehouse_dsn` (DSN), install the driver extra, author static flags (E20), mount the receiver (E19)
  — with the external dev-prerequisites named **honestly** (it is provisioning/config, not "config-only
  magic"). Same taxonomy, identity, allowlist, events as the PostHog config; zero consumer code change.
- **PostHog stays ONE selectable backend** — not the default, not the only one. The recipe and the gate
  both express this.
- Both gates run in the quality set (the E2 selection gate as a standing check; the E1 acceptance test
  in CI with Postgres spun up). TS/Python parity on the recipe and the selection gate.
- **Bar A proven end-to-end:** self-host = one adapter/receiver, zero consumer change. **Bar B proven
  end-to-end:** new-app self-host adoption = config + migration + mount, zero library change.

## Development prerequisites

- **A real/local Postgres in CI** for the E1 end-to-end zero-egress acceptance test. This is
  **test-infra** (spun up in CI), NOT a library edit — E17–E20 are all buildable/testable against the
  injected fake DB-execute seam without it, so this prerequisite lands on THIS epic only and does not
  gate building E17–E20. Not mirrored as a `blocked_by` (it gates the acceptance test's execution, not
  the epic's construction).
- **The Postgres must be ≥16** (surfaced by the E17-S2 review, 2026-07-14). The typed-view generator's
  safe-cast form uses `pg_input_is_valid` — a Postgres-16 function — so the generated view **requires
  PG ≥16**. Neon runs 16/17/18, so the greenfield target is fine. Two must-dos here: (1) the **E1
  acceptance test provisions PG ≥16**; (2) the **self-host recipe states the ≥16 floor** in its
  honest dev-prerequisites (a consumer on PG15 would get a view that errors at creation). Also carry a
  line for E18/E21 that `text→timestamptz` casts are session-`DateStyle`/`TimeZone`-dependent for
  ambiguous inputs (inherent to the cast, never an error — a query-time expectation note, not a defect).
- **MUST-FIX before the E1 real-Postgres test — the Python default-driver write path (surfaced by the
  E19 refinement, 2026-07-14).** `python/src/analytics_kit/query/default_db_execute.py` `_result_from_cursor`
  calls `cursor.fetchall()` unconditionally; on a non-RETURNING write (the E19 receiver's `INSERT …
  ON CONFLICT (uuid) DO NOTHING`), psycopg3 raises `ProgrammingError("the last operation didn't produce a
  result")` because `cursor.description is None`. The TS `pg` driver already conforms (returns `rows: []`).
  One-line guard: return an empty `DbExecuteResult` when `cursor.description is None`, BEFORE `fetchall()`.
  It is E17-driver-owned src and **unreachable from any E17–E20 test** (all fake-backed), so it was
  deliberately NOT folded into an E19 commit — it lands here, where the real driver first executes a write
  against real Postgres. Add a real-driver write unit test alongside the E1 test. (The receiver's own
  E19 tests stay fake-backed and green; this is the seam's real-driver conformance the fake can't cover.)

## Stories

- **[E21-S1](../stories/2-ready-for-dev/E21-S1-python-driver-write-path-fix.md)** *(additive, no deps)* — the recorded MUST-FIX: guard `_result_from_cursor` to return an empty `DbExecuteResult` when `cursor.description is None` (before `fetchall()`), plus a real-driver write unit test; TS already conforms. Unblocks the Python side of the E1 loop.
- **[E21-S2](../stories/2-ready-for-dev/E21-S2-factory-selection-standing-gate.md)** *(additive, no deps)* — the E2 standing factory-selection gate: given a self-host config, assert the warehouse query adapter (not HTTP), a local-only flag client with no flag URL, and a DSN-targeted receiver are selected — fast, no real Postgres, in the quality set at TS/Python parity.
- **[E21-S3](../stories/2-ready-for-dev/E21-S3-e2e-zero-egress-acceptance-test.md)** *(additive, depends on E21-S1)* — the E1 capstone: the full self-host loop against a real Postgres ≥16 behind a per-tree needs-Postgres test tier, asserting zero HTTP egress (recording-transport log empty of `/api/projects/.../query/`, `/flags/`, `/batch/`) and counts provably from Neon.
- **[E21-S5](../stories/2-ready-for-dev/E21-S5-warehouse-breakdown-fix.md)** *(additive, depends on E21-S3)* — Defect 3 fix (surfaced by the E1 capstone): the warehouse breakdown builders (trend/funnel/retention, both trees) group on `("<key>")::text` over the typed view instead of the non-existent raw `properties`, undeclared keys error at SQL-gen time, `WAREHOUSE-SCHEMA-CONTRACT.md` reconciled, + a real-PG breakdown scenario re-adding what S3 descoped.
- **[E21-S4](../stories/2-ready-for-dev/E21-S4-self-host-recipe-doc.md)** *(additive, depends on E21-S3 + E21-S5)* — the self-host recipe doc: the provider-swap walkthrough (migration, DSN, driver extra, static flags, receiver mount) with the external prerequisites named honestly and the PG ≥16 floor stated; PostHog framed as one selectable backend. Sequenced AFTER S5 so it documents WORKING breakdown, not a known limitation.

## Out of scope

- The warehouse substrate / query SQL / receiver / static flags themselves — **E17/E18/E19/E20** (this
  epic PROVES them; it does not build them).
- Replacing or weakening the name-based neutrality scan — this gate is ORTHOGONAL and ADDITIVE, not a
  replacement (name scan = observability neutrality; this = behavioral neutrality).
- An **AST-based** protocol scan — REJECTED; selection-level assertions + a recording-transport
  egress log are the chosen mechanisms (robust where URL-string / AST matching is brittle).
- Byte-exact HogQL parity checks — out (the warehouse semantics are documented divergence, per E18).
- Dashboards / visualization of the loop — consumer territory.

## Notes

Locked by architect consult (2026-07-13) — do not re-litigate in stories.

- **The acceptance bar this epic proves.** A consumer configured for self-host runs the FULL loop
  (capture → store → query + flags) against their own Neon Postgres, making ZERO HTTP calls to any
  PostHog host, with NO consumer code change vs the PostHog config (same taxonomy, identity, allowlist,
  events). Proven by an integration test asserting no PostHog-shaped endpoint is contacted and results
  come from Neon. PostHog stays as ONE selectable backend — not the default, not the only one. —
  architect (2026-07-13) + user decision
- **E — a SECOND, orthogonal gate.** Name scan = observability neutrality; this new gate = behavioral
  (protocol) neutrality. Two mechanisms:
  - **(E1)** end-to-end acceptance test — full self-host loop against a real Postgres; assert zero HTTP
    egress (a recording transport whose log is EMPTY of `/api/projects/.../query/`, `/flags/`,
    `/batch/`) + results provably from Neon.
  - **(E2)** standing FACTORY-SELECTION gate — given a self-host config, assert `create_query_client`
    returns `WarehouseQueryAdapter` (not HTTP), the flag client is local-only with no flag URL, the
    receiver writer targets the DSN. **Selection-level assertions are robust where URL-string matching
    is brittle.** Keep E2 as a fast integration test, NOT an AST pass. Run BOTH gates in the quality
    set. — architect (2026-07-13)
- **F — honest external dev-prerequisites; none is a library edit.** The recipe names, honestly: a Neon
  DSN, running the library migration, installing the driver extra, authoring static flags, mounting the
  receiver. All provisioning/config — none is a library edit. Do not over-claim "config-only." —
  architect (2026-07-13)
- **F — the injectable seam is why this epic (not E17–E20) carries the Postgres prerequisite.** The
  DB-execute seam is INJECTABLE (a fake in unit tests, like the existing transport injection), so
  E17–E20 are buildable/testable WITHOUT a real Neon. Only the E1 end-to-end test needs a real/local
  Postgres (test-infra, spun up in CI). So the Postgres-in-CI need is noted on THIS acceptance epic
  ONLY, and NOT as a blocking `blocked_by` on the build epics. — architect (2026-07-13)
- **Greenfield — no data-migration to prove.** The target consumer has no existing PostHog deployment
  or data, so the recipe covers a fresh self-host stand-up, not a vendor-to-Neon migration.
- **Mid-epic story addition — E21-S5 (Defect 3 fix), 2026-07-14.** The E1 capstone (E21-S3) surfaced,
  on real Postgres, that all three warehouse breakdown builders (trend/funnel/retention, both trees)
  emit `GROUP BY (properties ->> '<key>')` FROM `events_typed` — but the E17 view projects no raw
  `properties`, so **every breakdown query fails** (`column "properties" does not exist`),
  contradicting `WAREHOUSE-SCHEMA-CONTRACT.md:72`. Fake-backed E18/E19 tests never caught it. User
  decided (2026-07-14) to FIX before closing the cycle. **E21-S5** carries the fix — locked by an
  architect consult (2026-07-14): **option (a)** — breakdown groups on the declared typed view column
  (`("<key>")::text`, the `::text` cast keeping non-string breakdown values cross-tree-deterministic),
  undeclared keys **error at SQL-gen time**, and `WAREHOUSE-SCHEMA-CONTRACT.md` is **reconciled** (the
  self-granted "EXCEPT the breakdown path" exception is struck; line 72 stays verbatim — this tightens
  the contract, it does not open the one-way door). Ripple: the taxonomy is threaded the last hop
  (factory → warehouse adapter → the `build_*_sql` builders) so they know the declared key set. **Re-
  sequenced: S4 (recipe) now depends on [E21-S3, E21-S5]** so it documents WORKING breakdown, not a
  known limitation. New graph: `(S1 ∥ S2) → S3 → S5 → S4`. — architect (2026-07-14) + user decision

## Expansion path

The E2 selection gate extends additively as new backends land (assert selection for each). The recipe
grows a section per new self-host target (a non-Neon Postgres, a second warehouse dialect) without
changing the loop. The zero-egress assertion generalizes to any future vendor endpoint the recording
transport should never see.
