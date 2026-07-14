---
id: E21-OBS-protocol-neutrality-gate
status: planned
area: observability
touches: [adapters, query, node, feature-flags]
api_impact: additive
blocked_by: []
updated: 2026-07-13
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

## Stories

<Tentative slice — story files are drafted just-in-time at implement time.>

- **E2 factory-selection standing gate** — given a self-host config, assert `create_query_client`
  returns `WarehouseQueryAdapter`, the flag client is local-only with no flag URL, the receiver writer
  targets the DSN; added to the quality set as a fast integration test (not an AST pass).
- **E1 end-to-end zero-egress acceptance test** — full self-host loop against real/local Postgres;
  recording transport log empty of `/api/projects/.../query/`, `/flags/`, `/batch/`; results provably
  from Neon.
- **self-host recipe doc** — the provider-swap walkthrough (migration, DSN, driver extra,
  static-flag authoring, receiver mount) with the external prerequisites named honestly; PostHog framed
  as one selectable backend.

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

## Expansion path

The E2 selection gate extends additively as new backends land (assert selection for each). The recipe
grows a section per new self-host target (a non-Neon Postgres, a second warehouse dialect) without
changing the loop. The zero-egress assertion generalizes to any future vendor endpoint the recording
transport should never see.
