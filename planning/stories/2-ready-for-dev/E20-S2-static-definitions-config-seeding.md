---
id: E20-S2-static-definitions-config-seeding
epic: E20-FF-fully-local-flags
status: ready-for-dev
area: feature-flags
touches: [node, adapters]
depends_on: [E20-S1-neutral-flag-definition-type]
api_impact: additive
---

# E20-S2-static-definitions-config-seeding — Consumer-supplied static definitions seed the snapshot, bypassing the poller fetch

## Why

Local-only eval already makes zero `/flags/` calls; the only remaining remote dependency is the
definition SOURCE (the poller fetch). This story lets the consumer supply static flag definitions via
config — seeding the `DefinitionSnapshot` directly through S1's lowering, bypassing the fetch entirely.
That closes the last remote flag dependency: zero infra, the recommended self-host default, evaluator
unchanged.

## Scope

### In

- A new config field on the flag client's server config taking the NEUTRAL `FeatureFlagDefinition[]`
  from S1, at TS/Python parity:
  - **TS**: a field on `FlagClientConfig` (`ts/packages/node/src/flags/config.ts`), e.g.
    `staticDefinitions?: FeatureFlagDefinition[]`.
  - **Python**: the parity field on the flag config surface, e.g. `static_definitions`.
- Wiring: when static definitions are present, lower them via S1's `lowerDefinitions` /
  `lower_definitions` and seed the `DefinitionSnapshot` DIRECTLY into the local-eval path — the poller
  fetch is NOT started for the definition source. Validation runs loudly at seed time (S1's validator);
  malformed definitions fail at client construction.
- The static path selects a local-capable adapter (as `definitionsEndpoint` + `definitionsKey` do
  today), but with a config-sourced snapshot and NO definitions URL / NO fetch. With static definitions
  + local-only eval the flag client makes ZERO `/flags/` calls and has no flag/definitions URL.
- Document the local-only-by-default self-host posture: static definitions are the recommended
  zero-infra default; local-only-by-default; how it satisfies zero-`/flags/`-egress.
- Tests (both trees): a client configured with static definitions + local-only makes zero definition
  fetches and zero `/flags/` calls (assert against the injectable transport / recording transport),
  evaluates flags from the seeded snapshot, and returns the same values the poller path would for the
  equivalent definitions; malformed static definitions raise at construction.

### Out

- The neutral type, the lowering, and the validator themselves — those are S1 (this story consumes them).
- Any change to the evaluator (`compute_flag_locally` / `computeFlagLocally`) — UNCHANGED; only the
  definition source moves from fetch to config.
- The poller path — UNTOUCHED. Static seeding is ADDED alongside it; the poller is not removed or edited.
  (Whether static + poller can coexist is out of scope — the self-host default is static-only; do not
  build a merge/precedence layer beyond "static present ⇒ seed and skip the fetch".)
- The Neon `flag_definitions` table / warehouse-backed definition source — DEFERRED additive follow-up
  (see the epic's `## Stories`), NOT this cycle.
- The remote fallback suppression (`onlyEvaluateLocally` / `only_locally`) — already shipped; this story
  relies on it, does not re-implement it.

## Acceptance criteria

- [ ] A config field takes the NEUTRAL `FeatureFlagDefinition[]` (S1) and seeds the `DefinitionSnapshot`
      directly, bypassing the poller fetch — at TS/Python parity.
- [ ] With static definitions + local-only eval, the flag client makes ZERO `/flags/` calls and has no
      flag/definitions URL — proven against the recording/injectable transport in both trees.
- [ ] The seeded snapshot has the same shape the poller builds, so the UNCHANGED evaluator reads it
      identically; a flag evaluates to the same `FlagValue` + payload via static seeding as via the poller.
- [ ] Malformed static definitions are rejected loudly at seed time (client construction), via S1's
      validator.
- [ ] Bar A: same static definitions + evaluator resolve identically regardless of backend, zero consumer
      change. Bar B: a consumer enables fully-local flags by config alone (supply static definitions), zero
      library change.
- [ ] The local-only-by-default self-host posture is documented.
- [ ] All gates green in both trees (`build test typecheck lint` + neutrality-scan; `pytest ruff mypy` +
      Python scan).

## Technical notes

Locked by architect consult (2026-07-13, epic Notes D) — do not re-litigate:
local-only ALREADY makes zero `/flags/` calls (`only_locally` / `onlyLocally` suppresses the remote
fallback — `python/src/analytics_kit/flags/adapter.py`, TS `ts/packages/node/src/flags/`). This story
only relocates the DEFINITION SOURCE from the poller fetch to config; the evaluator is unchanged and the
poller path is untouched (static seeding is ADDED alongside it).

**Seed the same snapshot shape the poller holds.** Study how the poller builds/holds the snapshot so
the seed path produces the identical shape the evaluator reads:
- Python: `python/src/analytics_kit/flags/local/definition_poller.py` `_parse_definitions` builds a
  `DefinitionSnapshot(flags, flags_by_key, group_type_mapping, cohorts)` and swaps it in atomically;
  the adapter's local path reads `poller.get_snapshot()` and gates on `is_ready()`. The static path must
  produce an equivalent ready snapshot without the fetch — reuse S1's `lower_definitions` for the
  `flags` / `flags_by_key`; `group_type_mapping` and `cohorts` are empty in v1 (S1).
- TS: parity via `ts/packages/node/src/flags/local/definition-poller.ts` +
  `create-flag-client.ts` / `http-flag-adapter.ts`.
- Match the poller's readiness contract: a seeded snapshot must be treated as READY (non-empty flags)
  so local eval runs immediately without waiting on `wait_for_first_load` — there is no fetch to wait on.

**Config-field precedent.** `FlagClientConfig` (`ts/packages/node/src/flags/config.ts`) already carries
`definitionsEndpoint` + `definitionsKey` (poller path) + `onlyEvaluateLocally`. The static field is a
peer selector: presence ⇒ seed the snapshot from config + skip the fetch. Follow the existing
presence-based adapter selection ladder. — architect (via config.ts docstring)

**Validation at the input boundary (architect rider 1).** Reuse S1's seed-time validator — this story
calls it when reading the config field, so malformed definitions fail at client construction with the
config-layer error type (not lazily at first eval). Reject list lives in S1's Technical notes.

**Parity.** The config field name, the seeding, the zero-`/flags/` guarantee, and the documented
posture must be identical in concept across `ts/` and `python/`; only casing (`staticDefinitions` vs
`static_definitions`) and idiom differ. Mirror the existing `local-parity.test.ts` posture for the
zero-egress + equal-value assertions.

## Shipped

<!-- Empty at draft. /implement-epics fills this on move to 5-done/. Do not hand-edit. -->
