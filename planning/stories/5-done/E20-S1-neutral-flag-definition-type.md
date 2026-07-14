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
    closed `FlagFilterOperator` union. Re-exported from the node package's PUBLIC barrel
    `ts/packages/node/src/index.ts` (add an `export type { FeatureFlagDefinition, FlagCondition,
    PropertyFilter, FlagVariant, FlagFilterValue, FlagFilterOperator } from './flags/local/neutral-definition'`,
    alongside the existing `FlagClientConfig` / eval-surface re-exports) — the new consumer-INPUT
    surface, distinct from the frozen `FeatureFlagPort`/`FlagSet`/`FlagContext` eval surface (do NOT
    re-open those). Do NOT export it from the `local/index.ts` sub-barrel, which is the
    adapter-internal wire barrel ("NOT from the node package's own index.ts").
  - **Python** (`python/src/analytics_kit/flags/local/neutral_definition.py`): parity `TypedDict`s
    (`FeatureFlagDefinition`, `FlagCondition`, `PropertyFilter`, `FlagVariant`) + the `Literal`
    `FlagFilterOperator` union. snake_case field names (`property_filters`, `rollout_percentage`,
    `variant_override`) vs TS camelCase — identical concept, idiomatic expression. Re-export for parity
    the same way `FlagClientConfig` flows: surface it from the `analytics_kit.flags` barrel
    (`python/src/analytics_kit/flags/__init__.py`) and then from the top-level
    `python/src/analytics_kit/__init__.py` + its `__all__` — NOT from the internal `flags/local/__init__.py`
    barrel (that one is explicitly "not re-exported from the public package").
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
- [ ] The neutral type is exported from the node package's PUBLIC barrel as a consumer-INPUT type
      (TS: `ts/packages/node/src/index.ts`; Python: `analytics_kit.flags` → top-level `analytics_kit`
      `__init__`/`__all__`), NOT from the adapter-internal `local` sub-barrel; distinct from the frozen
      eval surface (`FeatureFlagPort`/`FlagSet`/`FlagContext` unchanged).
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
`filters.payloads` → `payloads` (keyed by RESOLVED value: a variant key, or `'true'`). NOTE: a
`'false'` key is UNREACHABLE under local eval — the resolver returns early on a `false`-resolved flag
BEFORE any payload lookup (`resolveLocalPayload` `if (value === false) return undefined` /
`_resolve_local_payload` `if value is False: return None`), so an off-state payload never fires. The
reachable key set is variant-key | `'true'` only; see the validation note for the dead-`'false'`-key
stance.

TS shape (mirror idiomatically in Python `TypedDict`s + a Pydantic validation layer):
```ts
export interface FeatureFlagDefinition {
  key: string;
  enabled: boolean;                  // wire: active. false ⇒ always resolves to false.
  conditions?: FlagCondition[];      // OR-ed. omitted/empty ⇒ nothing matches ⇒ false.
  variants?: FlagVariant[];          // present ⇒ multivariate; absent ⇒ boolean.
  payloads?: Record<string, unknown>;// keyed by resolved value (variant key | 'true'; 'false' is dead — see below)
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

**Operator union — VERIFIED COMPLETE against the real evaluator (refinement, 2026-07-14).** The 23
tokens above are EXACTLY the property-comparison operators `match_property` / `matchProperty` handles
(`ts/.../flags/local/match-property.ts` `switch` cases + the `is_not_set` branch handled before the
switch; `python/.../flags/local/match_property.py` string comparisons + the `_SEMVER_COMPARISON_OPERATORS`
/ `_SEMVER_RANGE_OPERATORS` tuples). No operator the engine supports is missing; none is listed that
it doesn't handle. `match_property` is the SOLE operator-switching site — the evaluator only feeds
plain-property filters to it. The cohort-membership operators (`in` / `not_in`) and the flag-dependency
`type: 'flag'` are handled in `_is_condition_match` / `match_cohort`, NOT in `match_property`, and their
capabilities (cohort refs, flag-deps) are scoped OUT of neutral v1 — so they correctly do NOT appear
in this property-filter operator union. — refinement (2026-07-14)

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

**Dead `'false'` payload key — WARN, never reject; deadness stays adapter-side (architect,
2026-07-14).** A `'false'` key in a definition's `payloads` map is UNREACHABLE (the local resolver
returns early on a `false`-resolved flag before any payload lookup — see the vocabulary-map note), but
it is harmless (it just sits unread). Do NOT hard-reject it: a definition carrying a `'false'` payload
round-trips fine from a remote source, so rejecting at seed time would introduce a static-vs-remote
asymmetry. Do NOT silently swallow it either — an off-state payload is almost always a consumer
mistake. So: accept the definition and emit a DEV-TIME WARNING naming the dead key. Scope the
deadness to the local static-seed validator ONLY — do NOT encode "false is dead" into the neutral
`FeatureFlagDefinition` TYPE (e.g. a keyed union excluding `'false'`): the type is the consumer seam
and a future non-PostHog adapter might resolve off-state payloads differently. Keep the type's
`payloads?: Record<string, unknown>` permissive; the reachability warning is an adapter-internal
mechanic of THIS resolver's early-return, not a neutral-contract invariant. — architect (2026-07-14)

**Versioned additive contract (architect rider 2 — CONFIRMED).** The neutral type shares no structural
identity with the wire shape (different names, flat vs nested, closed vs open operator, no `filters`
wrapper); the mapping is the ONLY thing that knows both. A future adapter negotiating a different
definition wire writes its OWN lowering from this same neutral type — the neutral type is the stable
contract, the wire churns behind the mapping (acceptance-bar-1 applied to definitions). Future
breaking-change risks to keep deliberate: the operator union (keep additive-only), the `payloads` key
contract (document it; it couples to the `FlagValue = string|boolean` resolution scheme), and the
keep-disabled-flags-in-snapshot decision (pin in v1). — architect (2026-07-14)

**S1 → S2 handoff (coordination — refinement, 2026-07-14).** `lowerDefinitions` / `lower_definitions`
must return a COMPLETE `DefinitionSnapshot` (the wire type in `definition-types.ts` /
`definition_types.py`) — `flags` (the lowered array), `flagsByKey`/`flags_by_key` (indexed by key,
keeping DISABLED flags in), `groupTypeMapping`/`group_type_mapping` = {}, `cohorts` = {} — so S2 can
wrap it directly in a seeded `DefinitionPoller` with NO further transformation. S2 relies on this being
the exact shape the poller's `_parse_definitions`/`fetchDefinitions` builds (verified against both
trees) so the UNCHANGED adapter reads it identically. Keep the readiness contract in mind: the lowered
snapshot must have non-empty `flags` for a non-empty authored set (S2's seeded poller reports ready via
the same `is_ready()` gate: `loadedSuccessfullyOnce && flags.length > 0`). — refinement (2026-07-14)

**Parity.** The neutral type, the lowering, and the validator must be identical in concept across
`ts/` and `python/`; only field-name casing and the schema tech (Zod vs Pydantic, interface vs
TypedDict) differ. A parity test asserts the two lowerings produce equivalent snapshots for the same
authored set (mirror the existing `local-parity.test.ts` posture — which uses `filters.groups` /
`filters.multivariate.variants` / `filters.payloads` fixtures keyed by stringified value `true` /
variant-key, NEVER a `false` key: the values-known-correct external contract the lowering output must
match).

> Reviewer suggestion (2026-07-14) → E20 improvement pass (defensive): Python `neutral_definition.__all__`
> lists `lower_definitions`/`validate_definitions`/`ValidationError` at MODULE level. It does NOT breach
> the package surface (verified absent from `analytics_kit.__all__`/`analytics_kit.flags.__all__`), but
> a future `from ...neutral_definition import *` could pull the wire-`DefinitionSnapshot`-returning
> `lower_definitions` into a barrel (a latent Bar-A leak), and re-exporting Pydantic's `ValidationError`
> in `__all__` is a subtle impl re-export. Trim the module `__all__` to the six neutral types (functions
> stay importable by explicit path for S2) — matching the TS module, which advertises nothing via a barrel.
> Reviewer suggestion (2026-07-14) → E20 improvement pass (message parity): TS rejects an empty variant
> key with a distinct `a variant has an empty 'key'` message; Python uses a generic Pydantic
> `min_length` error. Behaviorally equivalent; add an explicit Python check + matching phrase for
> consumer-facing diagnostic parity.

## Shipped

> Captured by `implement-epics` on 2026-07-14.

- **Files added:** TS `ts/packages/node/src/flags/local/neutral-definition.ts` (+ `validate-definitions.ts`, `neutral-definition.test.ts`); Python `python/src/analytics_kit/flags/local/neutral_definition.py` (+ `tests/test_neutral_definition.py`)
- **Files changed:** TS `ts/packages/node/src/index.ts`; Python `flags/__init__.py`, `__init__.py` (public exports — the six neutral TYPES only)
- **New public API:** `FeatureFlagDefinition`, `FlagCondition`, `PropertyFilter`, `FlagVariant`, `FlagFilterValue`, `FlagFilterOperator` (both trees, neutral vocabulary, type-only). The lowering + validator are INTERNAL (S2 imports by explicit module path) — NOT public (they'd drag the wire snapshot onto the surface)
- **Tests added:** TS 24 + Python 21 — lowering shape (complete snapshot, disabled kept, no wire tokens, vocab map, negated→negation, multivariate/variantOverride), the **lower-then-evaluate-equals-poller parity proof** (against a hand-authored wire fixture through the real evaluator), every validator reject case, dead-`'false'`-key WARN-not-reject, bar A, the public-surface contract
- **Commit:** this story's ship commit on `main` (see `git log`)
- **Reviewer notes:** independent gate verdict SHIP (no criticals) — **public surface verified structurally neutral in the built `dist/index.d.ts`** (zero wire tokens; six type-only exports; lowering/validator off every barrel). Builder's self-review already caught+fixed a public-export leak; the independent gate confirmed the fix at the artifact level. 2 forward suggestions above
- **Cross-story seams exposed:** **S2 imports** `lowerDefinitions`/`lower_definitions` + `validateDefinitions`/`validate_definitions` from the INTERNAL modules (`flags/local/neutral-definition` + `validate-definitions` / `flags.local.neutral_definition`) and the public `FeatureFlagDefinition` type for its `staticDefinitions?` config field. `lower_definitions` returns the COMPLETE seeded-poller-ready `DefinitionSnapshot` (non-empty `flags`, disabled kept in `flagsByKey`) — exactly what the poller builds, so S2's seeded poller reports ready via the same `is_ready()` gate. **Story wording nit for future readers: "Zod in TS" → there is no zod; the config-layer idiom is `throw new Error`** (implemented correctly).

## Follow-up

> E20 improvement pass (2026-07-14) — verified `__all__`/validator-message only (no shape/surface change).

- Trimmed the Python `neutral_definition.__all__` to the six neutral types only (reviewer suggestion — defensive): removed `lower_definitions`/`validate_definitions`/`ValidationError` from the module barrel so a future `from ...neutral_definition import *` can't pull the wire-`DefinitionSnapshot`-returning lowering into a barrel (a latent Bar-A leak). They stay importable by explicit path (S2's factory still works); package public surface unchanged (still six-types-only, pinned by a test).
- Empty-variant-key message parity (reviewer suggestion): the Python validator now raises `a variant has an empty 'key'` (an explicit `field_validator`) — matching the TS message verbatim — instead of a generic Pydantic `min_length` error. Still surfaces as `ValidationError`; behavior unchanged.
