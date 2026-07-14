---
id: E20-S1-neutral-flag-definition-type
epic: E20-FF-fully-local-flags
status: ready-for-dev
area: feature-flags
touches: [node, adapters]
depends_on: []
api_impact: additive
---

# E20-S1-neutral-flag-definition-type — Neutral consumer-facing flag-definition type + internal mapping to the snapshot

## Why

The moment a consumer authors static flag definitions (S2), the definition shape becomes a
consumer-facing surface — and the raw de-branded wire shape (`filters.groups`,
`ensure_experience_continuity`, `multivariate.variants`) is structurally PostHog-shaped, a Bar-A
structural leak. This story ships a purpose-designed NEUTRAL definition type consumers author, plus a
pure lowering to the wire `DefinitionSnapshot` the evaluator already reads — so S2 seeds from a clean,
vendor-neutral, versioned contract.

## Scope

### In

- A neutral consumer-facing flag-definition type in NEUTRAL vocabulary (no `filters.groups` /
  `ensure_experience_continuity` / `multivariate` / index-based tokens), at TS/Python parity:
  - **TS** (`ts/packages/node/src/flags/local/neutral-definition.ts`): `FeatureFlagDefinition`
    interface + supporting `FlagCondition`, `PropertyFilter`, `FlagVariant`, `FlagFilterValue`, and the
    closed `FlagFilterOperator` union. Type re-exported from the node package's public surface (the new
    consumer-INPUT surface, distinct from the frozen `FeatureFlagPort`/`FlagSet`/`FlagContext` eval
    surface — do NOT re-open those).
  - **Python** (`python/src/analytics_kit/flags/local/neutral_definition.py`): parity `TypedDict`s
    (`FeatureFlagDefinition`, `FlagCondition`, `PropertyFilter`, `FlagVariant`) + the `Literal`
    `FlagFilterOperator` union. snake_case field names (`property_filters`, `rollout_percentage`,
    `variant_override`) vs TS camelCase — identical concept, idiomatic expression.
- A pure lowering function (`lowerDefinitions` / `lower_definitions`) mapping
  `FeatureFlagDefinition[]` → the wire `DefinitionSnapshot` the evaluator consumes, at TS/Python parity.
  `group_type_mapping` and `cohorts` are EMPTY by design in v1 (no group-aggregation, no cohort refs).
- Seed-time input-boundary validation on the lowering entry (Zod in TS / Pydantic in Python) that
  rejects malformed definitions loudly BEFORE lowering (architect rider 1). See Technical notes for the
  exact reject list.
- Unit tests: round-trip a representative neutral definition set (boolean, multivariate, conditions
  with property filters + rollout + variant override, payloads) through the lowering and assert the
  produced snapshot evaluates identically to the same flags fetched via the poller path; assert the
  validator rejects each malformed case.

### Out

- The static-definitions CONFIG field + snapshot seeding into the adapter — that is S2 (this story ships
  the type + the pure mapping + the validator; S2 wires them to config).
- Any change to the wire types (`FlagDefinition` / `DefinitionSnapshot`) — they stay as-is; the neutral
  type is a NEW surface the mapping lowers onto.
- Any change to the evaluator (`compute_flag_locally` / `computeFlagLocally`) — untouched.
- Cohort references, experience-continuity, flag-dependencies, group-aggregation — deliberately NOT on
  the neutral v1 type (architect Deliverable 2). Their additive paths are recorded in Technical notes.
- The poller path — untouched; nothing in this story removes or edits the remote definition fetch.

## Acceptance criteria

- [ ] `FeatureFlagDefinition` (+ supporting types) exist at TS/Python parity, named in neutral
      vocabulary — zero `filters.groups` / `ensure_experience_continuity` / `aggregation_group_type_index`
      / `multivariate`-style tokens on the consumer-facing type. Both neutrality scans stay green.
- [ ] The neutral type is exported from the node package's public surface as a consumer-INPUT type,
      distinct from the frozen eval surface (`FeatureFlagPort`/`FlagSet`/`FlagContext` unchanged).
- [ ] `lowerDefinitions` / `lower_definitions` maps a neutral definition set to a `DefinitionSnapshot`
      losslessly for every in-scope capability; `group_type_mapping` and `cohorts` are empty.
- [ ] A neutral definition set lowered through the mapping evaluates identically (same `FlagValue`,
      same payloads) to the equivalent definitions loaded via the poller — proven by a parity test in
      both trees.
- [ ] Seed-time validation rejects (loudly, with a config-layer error) each malformed case in the
      Technical-notes reject list; a valid set passes.
- [ ] Bar A: the neutral definition type + lowering are backend-independent — the same authored
      definitions produce the same evaluation regardless of adapter, zero consumer change.
- [ ] All gates green in both trees (`build test typecheck lint` + neutrality-scan; `pytest ruff mypy` +
      Python scan).

## Technical notes

Neutral-type SHAPE + mapping designed by architect consult (2026-07-14) — the load-bearing design.
Ground the wire target in `ts/packages/node/src/flags/local/definition-types.ts` +
`python/.../flags/local/definition_types.py`; the evaluator read-surface in
`python/.../flags/local/evaluator.py` (TS parity).

**The neutral type (name by concept, not wire token).** Vocabulary map:
`filters.groups[]` → `conditions[]`; per-condition `properties[]` → `propertyFilters[]`;
`rollout_percentage` → `rolloutPercentage` / `rollout_percentage`; condition `variant` →
`variantOverride`; `filters.multivariate.variants` → flat `variants[]` (presence ⇒ multivariate,
absence ⇒ boolean); `active` → `enabled`; `FlagProperty.key` → `property`; `.negation` → `negated`;
`filters.payloads` → `payloads` (keyed by RESOLVED value: a variant key, or `'true'`/`'false'`).

TS shape (mirror idiomatically in Python `TypedDict`s + a Pydantic validation layer):
```ts
export interface FeatureFlagDefinition {
  key: string;
  enabled: boolean;                  // wire: active. false ⇒ always resolves to false.
  conditions?: FlagCondition[];      // OR-ed. omitted/empty ⇒ nothing matches ⇒ false.
  variants?: FlagVariant[];          // present ⇒ multivariate; absent ⇒ boolean.
  payloads?: Record<string, unknown>;// keyed by resolved value (variant key | 'true' | 'false')
}
export interface FlagCondition {
  propertyFilters?: PropertyFilter[];// AND together
  rolloutPercentage?: number;        // 0..100; omitted ⇒ admit all matched actors
  variantOverride?: string;          // must name a declared variant key
}
export interface PropertyFilter {
  property: string;                  // wire: FlagProperty.key
  operator?: FlagFilterOperator;     // default 'exact'; CLOSED union (below)
  value: FlagFilterValue;
  negated?: boolean;                 // wire: FlagProperty.negation
}
export interface FlagVariant { key: string; rolloutPercentage: number; }
export type FlagFilterValue = string | number | boolean | (string | number)[];
```
`FlagFilterOperator` is a CLOSED union of exactly the tokens the operator engine (`match_property`)
switches on: `exact | is_not | is_set | is_not_set | icontains | not_icontains | regex | not_regex |
gt | gte | lt | lte | is_date_before | is_date_after | semver_eq | semver_neq | semver_gt |
semver_gte | semver_lt | semver_lte | semver_tilde | semver_caret | semver_wildcard`. This is the one
place we diverge from the wire's open `operator?: string` — a closed union IS the consumer contract
and what the validator checks. Keep it additive-only (adding an operator = non-breaking; renaming =
breaking). — architect (2026-07-14)

**The mapping (pure lowering, neutral → wire `FlagDefinition` → snapshot).** Per-flag:
`key`→`key`; `enabled`→`active`; `conditions[]`→`filters.groups[]`;
`condition.propertyFilters[]`→`filters.groups[i].properties[]` (each `{property→key, operator (default
exact), value, negated→negation}`, **never emit a `type`** so the plain-property `match_property` path
runs); `condition.rolloutPercentage`→`filters.groups[i].rollout_percentage` (omitted ⇒ omit, evaluator
treats `None` as admit-all-matched); `condition.variantOverride`→`filters.groups[i].variant`;
`variants[]`→`filters.multivariate.variants[]` (present ⇒ emit; absent ⇒ omit `multivariate` entirely);
`payloads`→`filters.payloads` (keys already the resolved-value contract). Never emit
`aggregation_group_type_index`, `ensure_experience_continuity`, or `type: 'flag'`/`'cohort'`.
Snapshot: `flags`=lowered array, `flagsByKey`=indexed by key (keep DISABLED flags in the snapshot —
mirrors the poller; `flagsByKey` then distinguishes known-but-off from unknown; pin this in v1),
`groupTypeMapping`={} , `cohorts`={}. — architect (2026-07-14)

**Scoped OUT of neutral v1 (architect Deliverable 2), each with a clean additive path:**
- **Cohort refs** — need the server-provisioned `cohorts` map; a static consumer has no cohort ids.
  `match_cohort` raises `RequiresServerEvaluation` when absent. Additive-later as INLINE authored AND/OR
  property groups (a distinct larger type), NOT an opaque id ref.
- **Experience-continuity** — `ensure_experience_continuity` raises inconclusive UNCONDITIONALLY, never
  locally evaluable; omit entirely (no reserved field).
- **Flag-dependencies** (`type == 'flag'`) — raises inconclusive, never locally evaluable; omit.
- **Group-aggregation** — locally evaluable but needs `group_type_mapping` (index→name), a
  server-provisioned artifact keyed by a PostHog numeric index (a leak risk). Reserve the CONCEPT for
  later as a NEUTRAL name-based `aggregateBy?: string`, whose mapping SYNTHESIZES the index mapping from
  the authored names — the consumer never authors an index. Emit empty `group_type_mapping` in v1
  (every flag person-buckets). — architect (2026-07-14)

**Seed-time validation (architect rider 1 — Zod/Pydantic at the input boundary, at the lowering
entry, so a bad definition fails at client construction not lazily at first eval).** Reject loudly:
(1) missing/empty `key`, duplicate keys; (2) `operator` outside the closed union; (3)
`rolloutPercentage` (condition or variant) outside `0..100`; (4) multivariate variant
`rolloutPercentage` summing to **> 100** (< 100 is legal — gaps ⇒ bare `true` — so allow/warn, don't
reject); (5) `variantOverride` not matching any declared `variants[].key` (the evaluator only honors a
DECLARED override, else it silently no-ops — catch at seed); (6) `variants` present-but-empty or a
variant with empty `key`. Keep value/operator type-family checks LIGHT — the operator engine
string-folds, so over-strict `value` typing would diverge from eval semantics; reject only the clearly
broken. Throw the same error type the config layer already throws for a bad `FlagClientConfig`. —
architect (2026-07-14)

**Versioned additive contract (architect rider 2 — CONFIRMED).** The neutral type shares no structural
identity with the wire shape (different names, flat vs nested, closed vs open operator, no `filters`
wrapper); the mapping is the ONLY thing that knows both. A future adapter negotiating a different
definition wire writes its OWN lowering from this same neutral type — the neutral type is the stable
contract, the wire churns behind the mapping (acceptance-bar-1 applied to definitions). Future
breaking-change risks to keep deliberate: the operator union (keep additive-only), the `payloads` key
contract (document it; it couples to the `FlagValue = string|boolean` resolution scheme), and the
keep-disabled-flags-in-snapshot decision (pin in v1). — architect (2026-07-14)

**Parity.** The neutral type, the lowering, and the validator must be identical in concept across
`ts/` and `python/`; only field-name casing and the schema tech (Zod vs Pydantic, interface vs
TypedDict) differ. A parity test asserts the two lowerings produce equivalent snapshots for the same
authored set (mirror the existing `local-parity.test.ts` posture).

## Shipped

<!-- Empty at draft. /implement-epics fills this on move to 5-done/. Do not hand-edit. -->
