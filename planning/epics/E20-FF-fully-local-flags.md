---
id: E20-FF-fully-local-flags
status: planned
area: feature-flags
touches: [node, adapters]
api_impact: additive
blocked_by: []
updated: 2026-07-13
---

# E20-FF-fully-local-flags — Fully-local flags: consumer-supplied static definitions, zero remote dependency

## Why

Self-host must evaluate flags with ZERO calls to any PostHog host. Local-only evaluation ALREADY makes
zero `/flags/` calls (`only_locally`/`onlyLocally` suppresses the remote fallback) — the only remaining
remote dependency is the **definition SOURCE** (the poller fetch). This epic closes that last remote
dep for self-host by letting the consumer supply **static flag definitions** directly via config,
seeding the `DefinitionSnapshot` without any fetch — zero infra, the recommended self-host default. The
evaluator (`compute_flag_locally`) is unchanged; only the definition source moves from remote fetch to
consumer config.

## Success criteria

- A config field lets the consumer supply **static flag definitions** that seed the `DefinitionSnapshot`
  directly, **bypassing the poller fetch** — zero remote dependency, zero infra. This is the recommended
  self-host default.
- With static definitions + local-only eval, the flag client makes **zero `/flags/` calls and has no
  flag URL** — the definition source is config, the evaluator (`compute_flag_locally` /
  `computeFlagLocally`) is unchanged.
- The local-only-by-default self-host posture is **documented**.
- **Guard:** consumer-authored static definitions expose the de-branded `FlagDefinition` shape as a
  consumer-facing contract — **confirm zero vendor field names** in that surface.
- **Bar A:** flag evaluation is provider-independent — the same static definitions + evaluator work
  regardless of backend, zero consumer change. **Bar B:** a consumer enables fully-local flags by
  config alone (supply static definitions), zero library change.
- TS/Python parity on the static-definition config field, the snapshot seeding, and the documented
  posture. All gates green in both trees + both neutrality scans.

## Stories

<Tentative slice — story files are drafted just-in-time at implement time. Second story is additive and
explicitly deferrable.>

- **consumer-supplied static definitions** — a config field seeding the `DefinitionSnapshot` directly
  (bypassing the poller fetch); the zero-infra self-host default; evaluator unchanged; document the
  local-only default posture. Confirm the consumer-facing `FlagDefinition` shape carries zero vendor
  field names.
- **(additive, deferrable) Neon `flag_definitions` table + warehouse-backed definition fetch** — an
  `events`-schema-adjacent `flag_definitions` table + a warehouse-backed definition source, for
  consumers who prefer definitions in Neon over static config. Mark deferrable; not required for the
  acceptance bar.

## Out of scope

- The events schema / warehouse substrate — **E17** (the deferrable `flag_definitions` follow-up uses
  E17's migration mechanism but is not the events table).
- The warehouse query SQL — **E18**. The ingest receiver — **E19**.
- The protocol-neutrality gate + acceptance recipe — **E21**.
- Changing the evaluator (`compute_flag_locally`) — it is unchanged; only the definition SOURCE moves.
- Remote flag fetch / the poller path itself — untouched; this epic ADDS a static source alongside it,
  it does not remove the poller.

## Notes

Locked by architect consult (2026-07-13) — do not re-litigate in stories.

- **D — fully-local self-host posture.** local-only ALREADY makes zero `/flags/` calls today
  (`only_locally` / `onlyLocally` suppresses the remote fallback — verified in
  `python/src/analytics_kit/flags/adapter.py` and `ts/packages/node/src/flags/`). The ONLY remaining
  remote dep is the DEFINITION SOURCE. Ship **consumer-supplied STATIC definitions first** — a config
  field seeding the `DefinitionSnapshot` directly, bypassing the poller fetch; zero-infra; the
  recommended self-host default. The evaluator `compute_flag_locally` is UNCHANGED. — architect
  (2026-07-13)
- **D — the Neon table is an ADDITIVE follow-up.** A Neon `flag_definitions` table + warehouse-backed
  definition fetch is an ADDITIVE follow-up (deferrable) — for consumers who want definitions in Neon
  rather than static config. It is NOT required for the acceptance bar; static definitions satisfy the
  zero-`/flags/`-egress requirement on their own. — architect (2026-07-13)
- **D — the vendor-field guard.** Consumer-authored static definitions expose the de-branded
  `FlagDefinition` shape (`python/src/analytics_kit/flags/local/definition_types.py` /
  the TS analog) as a **consumer-facing contract** — confirm ZERO vendor field names in that surface
  before shipping (this is now a consumer-observable API, so the neutrality bar applies at the field
  level, not just the identifier scan). — architect (2026-07-13)
- **Lowest-risk epic in the cycle.** The remote fallback is already suppressible and the evaluator is
  already local; this epic only relocates the definition source to config. Risk: low.

## Expansion path

The deferrable `flag_definitions` warehouse source lands additively against the same DB-execute seam
and migration mechanism (E17), zero interface change — a second definition source behind the same
snapshot-seeding path. Flag payloads / additional local-eval operators extend the `FlagDefinition`
shape additively, in parity across both trees.
