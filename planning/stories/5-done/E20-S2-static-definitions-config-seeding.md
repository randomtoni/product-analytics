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
- The static path selects a local-capable adapter with a config-sourced snapshot and NO definitions
  URL / NO fetch. IMPORTANT: today the local-capable selector (`_build_local_capability` /
  `buildLocalCapability`) gates on BOTH `definitions_endpoint` AND `definitions_key` being present — a
  self-host consumer supplying static definitions supplies NEITHER. So the presence-based selection
  ladder must gain a NEW branch: `static_definitions` present ⇒ build the local capability with a
  SEEDED poller (no endpoint, no credential — see Technical notes), WITHOUT falling through to the
  no-op the `key`-but-no-route path yields today. Keep the existing endpoint+credential branch intact
  (the poller path is untouched). With static definitions + local-only eval the flag client makes ZERO
  `/flags/` calls and has no flag/definitions URL.
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

**Seed via a SEEDED POLLER — the confirmed seam (architect, 2026-07-14).** The adapter reads ALL
local eval through `local.poller` — the `is_ready()`/`isReady()` gate + `get_snapshot()`/`getSnapshot()`
read — and drives lifecycle through `poller.start()` (called unconditionally in the adapter
constructor) + `poller.stop()`. `is_ready()` is `loadedSuccessfullyOnce && snapshot.flags.length > 0`,
a flag flipped ONLY inside the poller's `fetchDefinitions`/`_fetch_definitions`. The static seed has no
fetch to flip it. So DO NOT fork the adapter's resolve path with a separate static-snapshot field —
instead construct a SEEDED `DefinitionPoller` (a seeded MODE of the same `DefinitionPoller` type, so
the `local.poller` field type is unchanged and the adapter can't tell the difference):
- It is constructed with the pre-lowered `DefinitionSnapshot` from S1's `lower_definitions` /
  `lowerDefinitions` and reports `is_ready()` TRUE from construction (snapshot seeded, the
  `loaded-successfully-once` flag set true, `flags.length > 0` holding via the lowered seed).
- Its `start()` is a REAL no-op — no thread, no URL resolution, no fetch (the adapter's constructor
  calls `start()` unconditionally; a seeded poller that started a thread or touched a URL would
  reintroduce the very fetch this story bypasses).
- Its `stop()` is an idempotent no-op that returns cleanly (no thread to join, no timer to cancel) —
  the adapter's lifecycle calls `poller.stop()` and must pass straight through.
- STRUCTURAL guardrail: the factory constructs the seeded poller WITHOUT the definitions endpoint /
  privileged credential the fetching poller needs — so "no fetch, no URL, no thread" is structural (it
  literally lacks what it would need to fetch), not merely dependent on the `start()` no-op holding.
This keeps the adapter's `_resolve` / `resolveLocalFirst` / `stop` / `start` code path BYTE-FOR-BYTE
unchanged (evaluator untouched, resolve branch untouched); the only new code is the seeded-poller
construction + the factory selection. — architect (2026-07-14)
- Python target: `python/src/analytics_kit/flags/local/definition_poller.py` (the seeded mode) +
  `factory.py` (`_build_local_capability` selects it). TS parity:
  `ts/packages/node/src/flags/local/definition-poller.ts` + `create-flag-client.ts` (`buildLocalCapability`).

**Config-field precedent + the new selection branch.** `FlagClientConfig`
(`ts/packages/node/src/flags/config.ts`, `python/.../flags/config.py`) already carries
`definitionsEndpoint`/`definitions_endpoint` + `definitionsKey`/`definitions_key` (poller path) +
`onlyEvaluateLocally`/`only_evaluate_locally`. Add `staticDefinitions?: FeatureFlagDefinition[]` /
`static_definitions` as a peer field (Pydantic `extra="forbid"` means it must be a real declared field
in the Python config, else a valid static-defs config raises loudly). The static field is a peer
LOCAL-CAPABLE selector, but note the current ladder: `_build_local_capability` / `buildLocalCapability`
returns `None`/`undefined` unless BOTH `definitions_endpoint` and `definitions_key` are set, and the
factory then falls to the no-op when there's no other route. So add a branch that returns a
local capability with a SEEDED poller when `static_definitions` is present (endpoint/credential NOT
required), and ensure the "keyed but no route ⇒ no-op" guard treats a static-defs config as a real
route. Do NOT build a static+poller merge/precedence layer (out of scope — static-only is the
self-host default). — architect (via config.ts docstring; refinement 2026-07-14)

**`key` requirement.** The factory's no-op branch triggers on `key is None` / `config.key === ''`.
A local-only static-defs client still needs a `key` (the poller's `token` project scope, and the
factory's non-no-op gate). Confirm the docs/example show a static-defs config supplying `key` +
`staticDefinitions` + `onlyEvaluateLocally: true` (and NO `definitionsEndpoint` / `definitionsKey` /
`flagEndpoint`) — that is the canonical zero-`/flags/` self-host shape. — refinement (2026-07-14)

**Validation at the input boundary (architect rider 1).** Reuse S1's seed-time validator — this story
calls it when reading the config field, so malformed definitions fail at client construction with the
config-layer error type (not lazily at first eval). Reject list lives in S1's Technical notes.

**Parity.** The config field name, the seeding, the zero-`/flags/` guarantee, and the documented
posture must be identical in concept across `ts/` and `python/`; only casing (`staticDefinitions` vs
`static_definitions`) and idiom differ. Mirror the existing `local-parity.test.ts` posture for the
zero-egress + equal-value assertions.

> Reviewer suggestion (2026-07-14) → E20 improvement pass (optional): an empty `staticDefinitions` under
> local-only builds a real (empty) route whose `isReady()` is permanently false, so every eval degrades
> silently to the unresolved set — unlike the keyed-but-no-route path, which `console.warn`s. Intended
> "valid empty seed" behavior (tests assert it), but a one-line dev-warn on an empty static set (both
> trees) would make an accidental empty config observable.
> Reviewer note (2026-07-14) → future follow-up (PRE-EXISTING, NOT introduced by S2, out of E20 scope):
> TS/Python `key`-guard asymmetry — TS no-ops on `key === undefined || key === ''`, Python only on
> `key is None` (an empty-string key passes through). Latent parity gap in `create-flag-client.ts` /
> `factory.py`; doesn't affect the static-defs path. A future ticket.

## Shipped

> Captured by `implement-epics` on 2026-07-14.

- **Files changed:** TS `flags/local/definition-poller.ts` (seeded mode), `config.ts` (`staticDefinitions?`), `create-flag-client.ts` (factory branch) + `static-definitions.test.ts`; Python `flags/local/definition_poller.py` (seeded), `local/neutral_definition.py` (`typing.TypedDict`→`typing_extensions.TypedDict`, Pydantic<3.12 boundary req), `config.py` (`static_definitions`), `factory.py` + `tests/test_flag_static_definitions.py`
- **New public API:** `staticDefinitions?: FeatureFlagDefinition[]` (TS `FlagClientConfig`) / `static_definitions` (Python) — takes the neutral S1 type
- **Tests added:** TS 8 + Python 9 — **zero-egress** (recording transport never hit across definitions GET + `/flags/` POST), canonical shape selects the real adapter, `stop()` idempotent no-op, **equal-value-vs-poller** (over a REAL socket, through the actual evaluator, + flipped-rollout negative control), malformed → raise at construction (transport untouched), unkeyed → `FlagNoop`, empty array degrades cleanly
- **Commit:** this story's ship commit on `main` (see `git log`)
- **Reviewer notes:** independent gate verdict SHIP (no criticals). **Zero-egress is STRUCTURAL** — the seeded poller carries no URL/credential/transport and every fetch entry point (`start`→`load`→`fetchDefinitions`) short-circuits; egress is impossible even against a direct `fetchDefinitions()` call. Adapter + evaluator **zero-diff** (verified). The `typing_extensions.TypedDict` swap validated as a mandatory boundary req (Pydantic reproduced the <3.12 error). 2 forward suggestions above
- **Cross-story seams exposed:** **E20 is CLOSED — self-host flag eval makes provably zero remote calls** (the last remote flag dependency, gone). Seeding is a seeded MODE of the same `DefinitionPoller` (so `local.poller` type + the adapter resolve path are unchanged); the config field takes the neutral S1 type; validation runs at construction. **E21** proves the full-loop zero-egress (recording-transport log empty of `/api/projects/.../query/`, `/flags/`, `/batch/`) and the standing factory-selection gate (a self-host flag config selects the local-only path).
