---
id: PY3-S2-taxonomy-registry-and-derive
epic: PY3-CORE-taxonomy-allowlist
status: ready-for-dev
area: core
touches: [privacy]
depends_on: [PY3-S1-allowlist-guard-and-wiring]
api_impact: additive
---

# PY3-S2-taxonomy-registry-and-derive — Runtime taxonomy registry + `derive_allowlist_from_taxonomy`

## Why

The runtime taxonomy registry is the full-fidelity half of the two-layer taxonomy: `define_taxonomy(decl)` returns an object whose `.decl` is the walkable registry that both drives `derive_allowlist_from_taxonomy` (the allowlist convenience) and powers runtime prop-type validation. One declaration, two jobs — ported from `ts/packages/analytics-kit/src/taxonomy.ts`. It has zero posthog analogue. This story lands the registry + the derive helper (which needs the registry shape, hence it sits after PY3-S1's `enforce_allowlist`).

## Scope

### In

- `analytics_kit/taxonomy.py`:
  - `PropType = Literal["string", "number", "boolean", "date"]` — the per-prop type-witness vocabulary (pure data), ported from TS.
  - `PropDecl = dict[str, PropType]` (prop-name → type-tag); `TaxonomyDecl` = a structure carrying `events: dict[str, PropDecl]`, optional `traits: PropDecl`, optional `groups: dict[str, PropDecl]` (a `TypedDict` or dataclass — the runtime-walkable decl).
  - `define_taxonomy(decl) -> Taxonomy` — returns a runtime object exposing `.decl` (the registry `derive_allowlist_from_taxonomy` walks and the static layer PY3-S3 brands off). **Reserves NOTHING** (see the architect ruling in Technical notes) — no reserved event-name exclusion set, no reserved-key prefix.
  - A **runtime prop-type validator** driven by `.decl`: the `PropType`→python-type map (`"string"→str`, `"number"→int | float`, `"boolean"→bool`, `"date"→datetime`), used at capture time to validate a consumer's supplied props against their declared types, honoring the `ViolationPolicy` (PY3-S1). Wire it as an optional runtime check the provider runs when a taxonomy is configured.
  - `derive_allowlist_from_taxonomy(taxonomy) -> list[str]` — a **standalone pure helper** (takes the taxonomy, NOT config): walks `decl.events` prop keys + `decl.traits` keys + `decl.groups` prop keys (the VALUES of events/groups, i.e. each `PropDecl`'s keys — so **no event NAMES and no group-TYPE names leak**), returns a **deduped** `list[str]`.
- Config wiring: `AnalyticsConfig` gains `taxonomy` additively (the `define_taxonomy` return); the provider runs the runtime prop-validator when a taxonomy is present. **`derive_allowlist_from_taxonomy` is consumer-invoked** — the consumer composes it into `config.allowlist` by spread (`allowlist=[*derive_allowlist_from_taxonomy(tax), "super_prop"]`); there is NO library auto-derivation from `config.taxonomy` (see Technical notes — the R1 lesson).

### Out

- The best-effort STATIC typing layer (`TypedDict`-per-event, `Literal` event-name union, generic keyed surface, mypy honesty tests) — **PY3-S3**. This story is the RUNTIME registry + derive + validator.
- Any reserved event-name set or reserved-key prefix — architect-ruled EMPTY/NONE server-side (Technical notes).
- Auto-deriving the allowlist from `config.taxonomy` — explicitly NOT done (the R1 bug; Technical notes).
- Server capture/query wiring (PY4/PY5).

## Acceptance criteria

- [ ] `define_taxonomy(decl)` returns an object exposing `.decl` at runtime (the walkable registry).
- [ ] `derive_allowlist_from_taxonomy(tax)` returns exactly the deduped set of all declared event-prop keys + trait keys + group-prop keys; **no event NAMES and no group-TYPE names** appear in the result; a keyless taxonomy derives `[]`.
- [ ] The runtime prop-type validator maps `PropType`→python type (`string→str`, `number→int|float`, `boolean→bool`, `date→datetime`) and, when a taxonomy is configured, a wrong-typed declared prop is caught at runtime honoring `ViolationPolicy` (throw / drop-and-error-log).
- [ ] **`define_taxonomy` reserves NOTHING** — a consumer may declare an event named `set_traits` / `set_group_traits` / `group_identify` (they are NOT reserved server-side); no reserved-key prefix is enforced. A dev-only `#`-comment records this is a deliberate server omission (no nameless-fallback mint, no shared super-prop store).
- [ ] **No auto-derivation from `config.taxonomy`:** supplying only a taxonomy (no explicit `allowlist`) leaves the guard INACTIVE — an off-taxonomy key reaches the adapter at runtime (typing decision ≠ privacy decision). A named test asserts this.
- [ ] Composition is consumer-side spread into the single `config.allowlist`; a super-prop key present in no event still passes when spread in; a taxonomy-derived key passes without restating it.
- [ ] `uv run mypy` (strict), `uv run ruff check`, `uv run pytest` all exit 0.
- [ ] Zero vendor token in `taxonomy.py` / docstrings; `grep -ri posthog analytics_kit/taxonomy.py` clean; the library ships zero event names.

## Technical notes

- **CONTRACT reference (ported, not de-branded):** `ts/packages/analytics-kit/src/taxonomy.ts` (`defineTaxonomy` + `PropType`/`PropDecl`/`TaxonomyDecl` + `ShapeOf`) and `ts/packages/analytics-kit/src/allowlist.ts` (`deriveAllowlistFromTaxonomy`), with the pinned name-exclusion + no-auto-derive semantics in `allowlist.test.ts`. **posthog-python has no taxonomy** — the library's own surface.
- **Reserved set = EMPTY; reserved prefix = NONE (server-side).** — architect (2026-07-10, dedicated consult, high confidence on both):
  - **(1) No reserved event names.** The TS `page`/`pageleave` reservation exists ONLY because those names are minted through a **nameless-fallback / unload path** (`page()` with no arg emits event name `page`; `pageleave` at unload) — real name-collision hazards. The server has NO such path (no `page()` verb, no unload). The server internal events (`set_traits`/`set_group_traits`/`group_identify`) are minted by the **verbs** `set()`/`set_group_traits()`, and recognition keys off the structural `internal_kind` discriminant (PY2-S1), NOT the name — so a consumer's `capture("set_traits", ...)` is correctly a plain consumer event (`internal_kind=None`). Reserving those names would REINTRODUCE the name-based reasoning the discriminant was built to retire, for zero safety. Rejected: reserving `{set_traits, set_group_traits, group_identify}` — solves a collision that can't occur server-side.
  - **(2) No reserved-key prefix.** The TS `__ak_` prefix is browser-persistence-only substrate (`ts/packages/browser/src/persistence-keys.ts`): it keeps the library's internal super-props disjoint from consumer-registered super-props *in a shared persisted store* (the `__ak_groups` case). The server has NO shared super-property store (no `register` verb; super_properties are config-time only, validated at the PY2-S3 config boundary), so there is nothing to namespace-guard. Rejected: porting `__ak_` "for parity" — a category error; guards a store the server doesn't have.
  - **Do NOT port** the TS `events: ... & { [K in RESERVED_...]?: never }` construct or any reserved-prefix guard. Leave a dev-only `#`-comment on `define_taxonomy` noting the deliberate server omission (mirrors PY2-S1's documented-omission posture).
- **NEVER auto-derive the allowlist from the taxonomy (the R1 hardening lesson).** — PM + architect: `derive_allowlist_from_taxonomy` is a **consumer-invoked convenience**, NOT an implicit default. Supplying `config.taxonomy` must NOT activate the allowlist guard. In TS R1, node was the outlier that auto-derived — a real bug (taxonomy=typing decision coupled to allowlist=privacy decision, AND it strands super-prop keys that live outside any event's taxonomy). Do NOT reintroduce it. There is ONE config field (`config.allowlist`); composition is the consumer's spread; the guard builds a `frozenset` from that single list. A named test must assert `create_analytics(config with taxonomy, no allowlist)` leaves the guard inactive.
- **`PropType`→python map (locked):** `"string"→str`, `"number"→int | float` (Python splits JS's `number`), `"boolean"→bool`, `"date"→datetime.datetime`. The runtime validator uses `isinstance` (note `bool` is a subclass of `int` — validate `boolean` before `number`, or exclude `bool` from the `number` check, so a `bool` isn't accepted as a `number`). This is a settled map — no consult needed.
- **Empty-list edge meets opt-in:** `derive_allowlist_from_taxonomy` returns `[]` for a keyless taxonomy; a consumer spreading only that yields `allowlist=[]`, which under PY3-S1's `is not None` activation is ACTIVE (allow-nothing → everything fails). Intended; call it out in the derive test so the interaction is visible.
- **Neutrality lesson — docstrings ship** vendor-neutral; only `#`-comments carry provenance.

## Shipped

<!-- Captured by implement-epics on close. -->
