---
id: E20-FF-fully-local-flags
status: planned
area: feature-flags
touches: [feature-flags, node, adapters]
api_impact: additive
blocked_by: []
updated: 2026-07-14
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
- **Guard (the real invariant is STRUCTURAL, not just token-level):** the moment consumer-authored
  static definitions become a consumer-facing surface, the neutrality bar that applies is *"no vendor
  type leaks to consumers"* — which a **structurally** PostHog-shaped schema (`filters.groups`,
  `ensure_experience_continuity`, `aggregation_group_type_index`, `multivariate.variants`) violates
  even though those field names carry no literal `posthog`/`$` token (so the name scan passes). Today
  this vocabulary is declared **adapter-internal wire** and is NOT exported from either package's public
  surface (`ts/packages/node/src/flags/local/definition-types.ts` docstring: "None of it appears on the
  neutral surface"; `python/.../flags/local/definition_types.py` `FlagDefinition = dict[str, object]`).
  **Open decision surfaced to the user (see Concern):** whether E20 exposes the raw de-branded wire
  shape directly (fast, but a Bar-A structural leak per architect) or introduces a **neutral,
  purpose-designed consumer-facing definition type + internal mapping** to `DefinitionSnapshot` (the
  Bar-A-clean path, but net-new seam surface beyond the locked decision). The token-level "zero vendor
  field names" check is necessary but NOT sufficient.
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
  local-only default posture. **Gated on the user's decision (see Notes D / Concern 1):** whether the
  consumer authors the raw de-branded wire shape or a new neutral definition type + mapping — that
  choice sets what this story builds and whether the Python side gains a structured type. The
  token-level "zero vendor field names" check is the floor, not the whole guard.
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
- **D — the vendor-field guard, and the structural-leak escalation (epic-refiner + architect,
  2026-07-14).** The locked decision framed this as "confirm ZERO vendor field names" in the
  consumer-authored `FlagDefinition` surface (`python/src/analytics_kit/flags/local/definition_types.py`
  — currently `dict[str, object]`; TS `ts/packages/node/src/flags/local/definition-types.ts` — a typed
  interface). Refinement found that check is **necessary but not sufficient**: the real neutrality bar
  on a consumer-facing surface is *"no vendor TYPE leaks,"* and the wire schema is **structurally**
  PostHog-shaped (`filters.groups`, `ensure_experience_continuity`, `aggregation_group_type_index`,
  `multivariate.variants`) — de-branded on names, not neutrally designed (both trees declare it
  adapter-internal, "None of it appears on the neutral surface"; it is not exported from either public
  package barrel). A follow-up architect consult (2026-07-14, HIGH confidence) ruled that exposing the
  raw shape is a Bar-A structural leak and that the clean fix — a **neutral consumer-facing definition
  type + internal mapping to `DefinitionSnapshot`** (with the Python side gaining a structured
  TypedDict/dataclass for parity; the internal wire types stay as-is) — is a **scope EXPANSION beyond
  the locked decision**, so it is surfaced to the user rather than silently encoded here. Two further
  architect asks if the neutral front lands: (1) validate malformed static definitions loudly at
  seed time (a genuine input boundary — Pydantic/Zod posture); (2) make the NEUTRAL type the versioned
  additive contract, decoupled from wire-shape churn. — architect (2026-07-13 locked; escalation
  2026-07-14)
- **Lowest-risk epic in the cycle.** The remote fallback is already suppressible and the evaluator is
  already local; this epic only relocates the definition source to config. Risk: low.

## Expansion path

The deferrable `flag_definitions` warehouse source lands additively against the same DB-execute seam
and migration mechanism (E17), zero interface change — a second definition source behind the same
snapshot-seeding path. Flag payloads / additional local-eval operators extend the `FlagDefinition`
shape additively, in parity across both trees.
