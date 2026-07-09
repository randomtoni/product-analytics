---
id: E3-S1-define-taxonomy-typed-facade
epic: E3-CORE-taxonomy-allowlist
status: ready-for-dev
area: core
touches: []
depends_on: []
api_impact: additive
---

# E3-S1-define-taxonomy-typed-facade — `defineTaxonomy()` runtime object + type brand + typed facade signatures

## Why

The typed-taxonomy mechanism is one half of "mechanism from the library, contents from the consumer": the consumer declares its own events/traits/groups and gets full compile-time safety, while the library ships zero event names. The declaration is a **runtime object** (not a bare generic) so the very same declaration also produces the runtime key registry the allowlist derivation (S3) walks — one declaration, two jobs.

## Scope

### In

- `defineTaxonomy<const T extends TaxonomyDecl>(decl: T): Taxonomy<T>` — a runtime object that carries `decl` (the walkable registry) and brands `T` for compile-time typing. The `const` type parameter captures the literal precisely.
- The declaration types (all in the seam, `packages/analytics-kit/src/`):
  - `PropType = 'string' | 'number' | 'boolean' | 'date'` — the primary per-prop type-witness vocabulary (pure data, serializable). A `prop<T>()` escape-hatch helper for union/optional/nested props is optional for this slice — may defer.
  - `PropDecl = Record<string, PropType>` — prop-name → type-tag.
  - `TaxonomyDecl = { events: Record<string, PropDecl>; traits?: PropDecl; groups?: Record<string, PropDecl>; page?: PropDecl }`.
  - `ShapeOf<T>` compile-time mapper (`events` → per-event resolved prop types, `traits`, `groups`, `page`) plus `PropsOf`/`TagToType`. `ShapeOf<T>` is the resolved TYPED shape the facade keys off. **It MUST conditionally fill absent `traits`/`groups`/`page`** with a present loose record (they are optional in `TaxonomyDecl`, so an omitted `traits`/`groups` would otherwise make `TX['traits']`/`keyof TX['groups']` resolve against `undefined`/`never` under strict) — see Technical notes for the exact mapper.
  - `TaxonomyShape` — the RESOLVED-shape family that constrains the generic (distinct from `TaxonomyDecl`, the tag family): `{ events: Record<string, NeutralProperties>; traits: NeutralTraits; groups: Record<string, NeutralTraits>; page: NeutralProperties }`. All four keys PRESENT.
  - `DefaultTaxonomyShape` — the fully-loose default (same shape as `TaxonomyShape`), so the untyped facade resolves EXACTLY to today's ergonomics.
  - `DefaultTaxonomyDecl` — the loose decl default used by the untyped overload path.
  - `Taxonomy<T> = { readonly decl: T }` — `decl: T` ties `T` into a used position so it is the brand (no phantom symbol needed).
- Make `AnalyticsProvider` generic: `AnalyticsProvider<TX extends TaxonomyShape = DefaultTaxonomyShape>`, default fully loose (preserves today's `track(event: string, props?: NeutralProperties)` ergonomics so an untyped consumer still compiles — bar B). Typed methods when a taxonomy is supplied:
  - `track<K extends keyof TX['events'] & string>(event: K, ...args: PropsParam<TX['events'][K]>): void`, where `type EmptyObject = {}` and `type PropsParam<P> = EmptyObject extends P ? [props?: P] : [props: P]` — a **conditional rest-tuple** so props are OPTIONAL on the loose default and on no-prop declared events, and REQUIRED+typed when the event declares props (no forced `{}`). The `& string` is defensive (keeps `K` in the string domain for the S3 walk). See Technical notes for the mechanics + the `no-empty-object-type` lint pin.
  - `group<G extends keyof TX['groups'] & string>(type: G, key: string, props?: TX['groups'][G]): void`
  - `identify(id, traits?: Partial<TX['traits']>, traitsOnce?: Partial<TX['traits']>)`, `setTraits(traits: Partial<TX['traits']>, once?)`
  - `page(name?: string, props?: NeutralProperties)` — reserved slot typing only; **typed page-slot props deferred** (see Technical notes).
- `createAnalytics` becomes two **ordered overloads (specific-first — the order is load-bearing; loose-first would shadow the taxonomy overload and silently drop typing)**; `AnalyticsConfig` stays NON-generic and gains an optional `taxonomy?: Taxonomy<TaxonomyDecl>` member:
  - `createAnalytics<const T extends TaxonomyDecl>(config: AnalyticsConfig & { taxonomy: Taxonomy<T> }, adapter?): AnalyticsProvider<ShapeOf<T>>`
  - `createAnalytics(config: AnalyticsConfig, adapter?): AnalyticsProvider`
  `T` is inferred from `config.taxonomy` (the `defineTaxonomy(...)` return, a `Taxonomy<T>`). **`AnalyticsProviderImpl` stays non-generic** (implements the loose default contract); the overload signatures assert the narrowed return — no `as`-cast inside the impl. Do NOT use a single generic signature with a `DefaultTaxonomyDecl` default: it forces `ShapeOf<DefaultTaxonomyDecl> === DefaultTaxonomyShape`, which is fragile (a mapped `ShapeOf` over the loose decl narrows props to `string|number|boolean|Date`, not the loose `unknown`, breaking backward-compat) — see Technical notes.
- Reserved `page` slot: type-forbid the reserved neutral page name as a consumer `events` key (`events: Record<string, PropDecl> & { [K in typeof RESERVED_PAGE_EVENT]?: never }`), so declaring a colliding event is a compile error. Add the reserved `page?: PropDecl` slot to `TaxonomyDecl` (typed page-props deferred).
- Rename the collidable `DEFAULT_PAGE_NAME = 'page'` fallback (`analytics-provider.ts`) to `RESERVED_PAGE_EVENT` — a neutral, non-`$`, clearly-reserved token.
- Export `defineTaxonomy`, `Taxonomy`, `TaxonomyDecl`, `PropType`, `PropDecl`, `ShapeOf` (and the default-shape types) from `src/index.ts`.
- Update the E2 type-pin tests to the new shapes (expected churn — see Technical notes). **Two test files, not one:**
  - `analytics-provider.test.ts` per-signature pin (~lines 360-382): rewrite the `track` and `group` assertions (now generic) and the `identify`/`setTraits` assertions (now `Partial<TX['traits']>`). `page` stays loose so its pin is unchanged; `reset`/`optIn`/`optOut`/`hasOptedOut`/`flush`/`shutdown` are unchanged.
  - `create-analytics.test.ts`: the `AnalyticsConfig` shape pin (~line 149, `expectTypeOf<AnalyticsConfig>().toEqualTypeOf<{ key?: string }>()`) **breaks** once `AnalyticsConfig` gains `taxonomy?` — rewrite it (and its `AnalyticsConfig.key is the only field E2 needs` title/assertion) to the extended shape. Verify the `createAnalytics` return/params pin (~lines 138-141) under the overloads: `typeof createAnalytics` resolves to the loose overload, so it is expected to hold — confirm rather than assume.
  - `analytics-provider.test.ts` `page without a name falls back to a neutral placeholder` (~lines 117-129): line 125 asserts `expect(event.event).toBe('page')`. **If you change the `RESERVED_PAGE_EVENT` value away from `'page'`** (the collision-minimization guidance nudges toward a more clearly-reserved literal), update this assertion to the new token — the `not.toContain('$')` assertion (line 126) stays valid. Expected churn, not a regression; if you keep the value `'page'`, this test is untouched.

### Out

- The allowlist guard + `onViolation` config — **S2**.
- `deriveAllowlistFromTaxonomy` convenience + the consumer-supplied-value-gated path — **S3**.
- Typed **super-properties** and typed **page-slot props** — deferred (additive expansion; see Technical notes on the resolved planning flag).
- A structural page-ness discriminator field on `NeutralEvent` — **E6** (page enrichment); E3 does reserved-name typing only.
- Adapter wire-mapping of the neutral event → vendor shape — E2 SPI / adapters.

## Acceptance criteria

- [ ] `defineTaxonomy(decl)` returns an object exposing `decl` at runtime; the `const` param narrows event/prop/trait/group types to literals.
- [ ] With a supplied taxonomy, `track('declared_event', { …typed props })` type-checks; `track('undeclared_event', …)` and a wrong prop type are compile errors (assert via `expectTypeOf` / `@ts-expect-error`); a **no-prop declared event** allows `track('event')` with props omitted (not a forced `{}`).
- [ ] `group`/`identify`/`setTraits` narrow to the declared `groups`/`traits` shapes; a no-taxonomy consumer (`createAnalytics({})`) still compiles with the loose default, and **`createAnalytics({}).track('x')` compiles with no props arg** (the loose-default rest-tuple keeps props optional) — **bar B: adding a taxonomy is config only, zero library change; the 10 E2 single-arg `track('x')` sites stay green**.
- [ ] Declaring an event under the reserved page name is a compile error; `RESERVED_PAGE_EVENT` is neutral, contains no `$`, and is chosen so no plausible consumer event collides.
- [ ] The 13-member `keyof AnalyticsProvider` type-pin (E2 `analytics-provider.test.ts`) is unchanged (generics add no keys, member names identical); the per-signature pin (`track`/`group`/`identify`/`setTraits`) and the `create-analytics.test.ts` `AnalyticsConfig` shape pin are rewritten to the new shapes.
- [ ] `AnalyticsProviderImpl` is non-generic; `ShapeOf<T>` threads through only the specific `createAnalytics` overload's return type (the overload signatures assert the narrowed return — no `as`-cast in the impl). Runtime behavior of `track`/`page`/etc. is unchanged by this story.
- [ ] `grep -ri posthog packages/analytics-kit/src` is clean; the library ships zero event names.
- [ ] `pnpm --filter analytics-kit typecheck`, `lint`, `test`, `build` all exit 0.

## Technical notes

- **`defineTaxonomy` shape (— architect 2026-07-07):** option (a) — one runtime object literal, `T` inferred via a `const` type parameter; per-event value is a **key → type-witness record** (`PropType` tags), not a value-type (erases) and not a bare key-array (loses per-prop types). Rejected: (b) explicit generic + separate manifest (two sources of truth, drift); (c) Zod (it's a value-validator; the runtime registry only needs key names, and the BRIEF reserves Zod for genuine wire boundaries — here the derived `string[]` in S3 is the boundary, not the taxonomy). One literal yields both `Object.keys` (runtime registry) and precise per-prop types.
- **Generic defaulting — concrete shapes, empirically verified (— architect 2026-07-07):** the two type families and the exact resolved shapes:
  - `TaxonomyShape` (the `AnalyticsProvider` constraint) and `DefaultTaxonomyShape` both carry all four keys PRESENT: `{ events: Record<string, NeutralProperties>; traits: NeutralTraits; groups: Record<string, NeutralTraits>; page: NeutralProperties }`. The constraint must be `TaxonomyShape` (real TS types), NOT `TaxonomyDecl` (tags) — otherwise `track('e', { plan: 'pro' })` would demand the literal tag `'string'`.
  - `ShapeOf<T>` conditionally fills absent `traits`/`groups`/`page` so `keyof`/`Partial` never hit `undefined`/`never`: `traits: T extends { traits: PropDecl } ? PropsOf<T['traits']> : NeutralTraits`; `groups: T extends { groups: Record<string, PropDecl> } ? { [G in keyof T['groups']]: PropsOf<T['groups'][G]> } : Record<string, NeutralTraits>`; `page` analogously. Verified: a `{ events: { ping: {} } }` decl (no traits/groups/page) still compiles `identify`/`setTraits`/`group`.
  - Loose-default `track` premise correction: `keyof Record<string, X>` resolves to **`string`** (not `string | number` — that widening only bites an inline index signature), so `event` does not widen; `& string` is kept purely defensive.
  - **Conditional rest-tuple** is the tool that keeps default/no-prop props optional while making declared props required: `type EmptyObject = {}; type PropsParam<P> = EmptyObject extends P ? [props?: P] : [props: P];`. Only top-`{}` gives the "no required keys" test — `Record<string, never>` is wrongly assignable to `{plan:string}` and would make declared events optional. Verified across default / declared-with-props / declared-empty.
  - **Factory = ordered overloads, specific-first** (see Scope.In) — NOT a single generic-with-default signature (that forces `ShapeOf<DefaultTaxonomyDecl> === DefaultTaxonomyShape`, fragile). `AnalyticsProviderImpl` stays non-generic; overloads assert the narrowed return.
  - **Lint pin (will fail the gate otherwise):** the `EmptyObject = {}` alias trips `@typescript-eslint/no-empty-object-type` (active via `tseslint.configs.recommended`). Either configure `'@typescript-eslint/no-empty-object-type': ['error', { allowWithName: 'EmptyObject' }]` or a scoped `// eslint-disable-next-line` on the alias. Consumer/test decls like `defineTaxonomy({ events: { logged_out: {} } })` are runtime object literals and do NOT trip the rule (type positions only), so `PropsParam`'s alias is the only library-side hit.
- **Type-pin churn is expected E3 scope, not a regression (— architect 2026-07-07):** the 13-member `keyof AnalyticsProvider` pin (E2 `analytics-provider.test.ts` ~line 310) stays valid — generics add no keys. What **will and must change** — a generic/narrowed method is never `toEqualTypeOf`-equal to the old non-generic one, so treat these as feature-churn, not regressions:
  - `analytics-provider.test.ts` per-signature block (~lines 360-382): `track` and `group` (now generic) AND `identify`/`setTraits` (now `Partial<TX['traits']>`) change. `page` stays loose (unchanged); `reset`/`optIn`/`optOut`/`hasOptedOut`/`flush`/`shutdown` unchanged.
  - `create-analytics.test.ts` (~line 149): `expectTypeOf<AnalyticsConfig>().toEqualTypeOf<{ key?: string }>()` breaks once `AnalyticsConfig` gains `taxonomy?` — rewrite it. The `createAnalytics` return/params pin (~lines 138-141) resolves to the loose overload and is expected to hold — confirm.
  Do not treat byte-identical signatures as a constraint; that fights the feature.
- **Reserved page slot (— architect 2026-07-07, Q3):** two mechanisms together — (1) top-level reserved `page?: PropDecl` slot in `TaxonomyDecl` (so typed page-props extend additively later); (2) type-forbid the reserved neutral page name as a consumer `events` key via `& { [K in typeof RESERVED_PAGE_EVENT]?: never }`. Runtime page-ness: **E3 does the reserved-name rename only** — rename `DEFAULT_PAGE_NAME='page'` → `RESERVED_PAGE_EVENT` (the rename and the type-forbid are the same decision, land together). **Defer the structural `NeutralEvent` discriminator to E6**, where page enrichment consumes it; adding a discriminator to the frozen `NeutralEvent` now, with nothing to consume it, is premature.
- **Vendor-neutral trap on the reserved name (— architect 2026-07-07):** posthog-js marks pageviews with the reserved event name `$pageview` — the reference for *what* page-ness is and exactly what NOT to copy. The neutral reserved token must be library-owned, non-`$`, non-colliding, clearly reserved. The literal is a builder naming call within those constraints (the type-level exclusion makes compile-time collision impossible regardless; choose the literal to also minimize runtime collision for untyped consumers).
- **Resolved planning flag — super-props / page-slot props DEFER (PM 2026-07-07):** the first `T` ships `events` / `traits?` / `groups?` + the reserved `page` slot only. The example consumer (Fernly, E10) declares 7 typed events, maps role→trait and workspace/team→`group()`, and uses manual `page()` — but declares NO typed super-properties and NO typed page-specific props. The minimal `T` covers Fernly end-to-end; typed super-props and typed page-slot props stay additive expansions (they extend `T` without moving the S2 guard) until a real consumer needs them.
- **Props-optionality — RESOLVED at refinement (— architect 2026-07-07):** a bare `props: TX['events'][K]` would make props *required* (forcing `{}` on no-prop events AND breaking the loose-default `track('x')` / bar B). Resolved to the conditional rest-tuple `...args: PropsParam<TX['events'][K]>` (see Generic-defaulting note) — props optional-when-empty, required-when-declared. This is now pinned, not a settle-at-impl choice.
- **No posthog-js analogue** for the taxonomy generic — entirely the library's own surface. Ground the TS mechanics in the shipped E2 seam (`analytics-provider.ts`, `neutral-event.ts`, `create-analytics.ts`), not in `posthog-js`.
- > Reviewer suggestion (2026-07-07, improvement-pass candidate): remove `DefaultTaxonomyDecl` (`taxonomy.ts`) — declared + module-exported but referenced nowhere (vestige of the pre-overload design; the loose overload uses `DefaultTaxonomyShape`, not a decl default). Dead code.
- > Reviewer suggestion (2026-07-07): `RESERVED_PAGE_EVENT='page'` fully protects TYPED consumers (declaring a `page` event is a compile error) and is non-`$`, so the hard AC is met — but an UNTYPED consumer's `track('page', …)` collides at runtime with the bare `page()` fallback (both emit `event:'page'`). Consider a more clearly-reserved neutral literal (e.g. `page_view`) to shrink untyped collision, OR accept deliberately. Note: changing the value churns the E2 page-fallback test and touches the emitted event name — coordinate with E6 (which owns page semantics/enrichment). Story explicitly sanctioned keeping `'page'`.

## Shipped

> Captured by `implement-epics` on 2026-07-07.

- **Files added:** `packages/analytics-kit/src/taxonomy.ts` (declaration types + `defineTaxonomy` + `RESERVED_PAGE_EVENT` + `ShapeOf`/`PropsParam`/shape families), `src/taxonomy.test.ts` (11 tests)
- **Files changed:** `src/analytics-provider.ts` (generic `AnalyticsProvider<TX>` + typed track/group/identify/setTraits; `DEFAULT_PAGE_NAME`→`RESERVED_PAGE_EVENT`), `src/create-analytics.ts` (two ordered overloads specific-first; `AnalyticsConfig.taxonomy?`), `src/index.ts` (exports), `src/analytics-provider.test.ts` + `src/create-analytics.test.ts` (type-pin rewrites)
- **New public API:** `defineTaxonomy`, `Taxonomy`, `TaxonomyDecl`, `PropType`, `PropDecl`, `ShapeOf`, `TaxonomyShape`, `DefaultTaxonomyShape`; `AnalyticsProvider<TX>` generic; `AnalyticsConfig.taxonomy?`
- **Tests added:** 11 (typed-props OK, undeclared/wrong-type/missing-props compile errors, no-prop `track('event')`, **bar-B `createAnalytics({}).track('x')`**, group/traits narrowing, absent-slot fill, reserved-page compile error, runtime `decl` registry walk). 66 total in package.
- **Commit:** `E3-S1-define-taxonomy-typed-facade — defineTaxonomy() runtime object + type brand + typed facade signatures` on `core-cycle`
- **Reviewer notes:** 0 critical, 2 suggestions → see Technical notes (remove dead `DefaultTaxonomyDecl`; reconsider `'page'` reserved literal). Bar B + typed safety independently verified by the reviewer.
- **Cross-story seams exposed:** **S3** walks `defineTaxonomy(decl).decl` (runtime registry: `Object.keys` over events/traits/groups/page prop names; `TaxonomyDecl`/`Taxonomy<T>` exported). **S2** attaches its guard to the guarded verbs on the non-generic `AnalyticsProviderImpl` (single call boundary); `AnalyticsConfig` already threads through `createAnalytics` for S2's `allowlist?`/`onViolation?` additions. `AnalyticsProviderImpl` stays non-generic (runtime untouched); `ShapeOf<T>` threads only the specific overload's return.

## Follow-up

> E3 post-close improvement pass, 2026-07-07 (commit follows). Reviewer-verified, no regression (93 tests green, public surface unchanged).

- **Removed dead `DefaultTaxonomyDecl`** (`taxonomy.ts`) — declared + module-exported but referenced nowhere (vestige of the pre-overload design). `DefaultTaxonomyShape` (distinct, still public) untouched. (Addresses this story's reviewer suggestion #1.)
- **Skipped with reason:** the `RESERVED_PAGE_EVENT='page'` reserved-literal reconsideration remains captured in Technical notes — it changes the emitted `page()` event name and is E6's semantic domain (page enrichment); not an E3 improvement-pass change. Deferred to E6.
