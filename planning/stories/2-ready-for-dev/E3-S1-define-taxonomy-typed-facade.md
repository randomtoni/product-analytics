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
  - `ShapeOf<T>` compile-time mapper (`events` → per-event resolved prop types, `traits`, `groups`) plus `PropsOf`/`TagToType`. `ShapeOf<T>` is the resolved TYPED shape the facade keys off.
  - `Taxonomy<T> = { readonly decl: T }` — `decl: T` ties `T` into a used position so it is the brand (no phantom symbol needed).
- Make `AnalyticsProvider` generic: `AnalyticsProvider<TX extends TaxonomyShape = DefaultTaxonomyShape>`, default fully loose (preserves today's `track(event: string, props?: NeutralProperties)` ergonomics so an untyped consumer still compiles — bar B). Typed methods when a taxonomy is supplied:
  - `track<K extends keyof TX['events']>(event: K, props: TX['events'][K]): void`
  - `group<G extends keyof TX['groups']>(type: G, key: string, props?: TX['groups'][G]): void`
  - `identify(id, traits?: Partial<TX['traits']>, traitsOnce?: Partial<TX['traits']>)`, `setTraits(traits: Partial<TX['traits']>, once?)`
  - `page(name?: string, props?: NeutralProperties)` — reserved slot typing only; **typed page-slot props deferred** (see Technical notes).
- `createAnalytics<const T extends TaxonomyDecl = DefaultTaxonomyDecl>(config: AnalyticsConfig<T>, adapter?)` infers `T` from `config.taxonomy` and returns `AnalyticsProvider<ShapeOf<T>>`. **`AnalyticsProviderImpl` stays non-generic** (implements the loose default contract); the factory casts the RETURN type.
- Reserved `page` slot: type-forbid the reserved neutral page name as a consumer `events` key (`events: Record<string, PropDecl> & { [K in typeof RESERVED_PAGE_EVENT]?: never }`), so declaring a colliding event is a compile error. Add the reserved `page?: PropDecl` slot to `TaxonomyDecl` (typed page-props deferred).
- Rename the collidable `DEFAULT_PAGE_NAME = 'page'` fallback (`analytics-provider.ts`) to `RESERVED_PAGE_EVENT` — a neutral, non-`$`, clearly-reserved token.
- Export `defineTaxonomy`, `Taxonomy`, `TaxonomyDecl`, `PropType`, `PropDecl`, `ShapeOf` (and the default-shape types) from `src/index.ts`.
- Update the E2 per-signature type-pin test to the new defaulted/narrowed shapes (expected churn — see Technical notes).

### Out

- The allowlist guard + `onViolation` config — **S2**.
- `deriveAllowlistFromTaxonomy` convenience + the consumer-supplied-value-gated path — **S3**.
- Typed **super-properties** and typed **page-slot props** — deferred (additive expansion; see Technical notes on the resolved planning flag).
- A structural page-ness discriminator field on `NeutralEvent` — **E6** (page enrichment); E3 does reserved-name typing only.
- Adapter wire-mapping of the neutral event → vendor shape — E2 SPI / adapters.

## Acceptance criteria

- [ ] `defineTaxonomy(decl)` returns an object exposing `decl` at runtime; the `const` param narrows event/prop/trait/group types to literals.
- [ ] With a supplied taxonomy, `track('declared_event', { …typed props })` type-checks; `track('undeclared_event', …)` and a wrong prop type are compile errors (assert via `expectTypeOf` / `@ts-expect-error`).
- [ ] `group`/`identify`/`setTraits` narrow to the declared `groups`/`traits` shapes; a no-taxonomy consumer (`createAnalytics({})`) still compiles with the loose default `track(string, props?)` — **bar B: adding a taxonomy is config only, zero library change**.
- [ ] Declaring an event under the reserved page name is a compile error; `RESERVED_PAGE_EVENT` is neutral, contains no `$`, and is chosen so no plausible consumer event collides.
- [ ] The 13-member `keyof AnalyticsProvider` type-pin (E2 `analytics-provider.test.ts`) is unchanged (generics add no keys, member names identical); the per-signature pin is rewritten to the new defaulted/narrowed shapes.
- [ ] `AnalyticsProviderImpl` is non-generic; the factory return-type cast is the only place `ShapeOf<T>` threads through. Runtime behavior of `track`/`page`/etc. is unchanged by this story.
- [ ] `grep -ri posthog packages/analytics-kit/src` is clean; the library ships zero event names.
- [ ] `pnpm --filter analytics-kit typecheck`, `lint`, `test`, `build` all exit 0.

## Technical notes

- **`defineTaxonomy` shape (— architect 2026-07-07):** option (a) — one runtime object literal, `T` inferred via a `const` type parameter; per-event value is a **key → type-witness record** (`PropType` tags), not a value-type (erases) and not a bare key-array (loses per-prop types). Rejected: (b) explicit generic + separate manifest (two sources of truth, drift); (c) Zod (it's a value-validator; the runtime registry only needs key names, and the BRIEF reserves Zod for genuine wire boundaries — here the derived `string[]` in S3 is the boundary, not the taxonomy). One literal yields both `Object.keys` (runtime registry) and precise per-prop types.
- **Generic defaulting (— architect 2026-07-07):** `AnalyticsProvider<TX extends TaxonomyShape = DefaultTaxonomyShape>` with the default fully loose; `createAnalytics` infers the decl from `config.taxonomy` and returns `AnalyticsProvider<ShapeOf<T>>`. Keep `AnalyticsProviderImpl` non-generic — `T` is pure compile-time; the class implements the loose default and the factory casts the return type. Idiomatic (generic interface + non-generic impl + return-type cast) and correct because the S2 guard operates on erased runtime values anyway.
- **Type-pin churn is expected E3 scope, not a regression (— architect 2026-07-07):** the 13-member `keyof AnalyticsProvider` pin (E2 test ~line 310) stays valid — generics add no keys. The per-signature pin (~line 360) that asserts `AnalyticsProvider['track']` `toEqualTypeOf` `(event: string, props?: NeutralProperties) => void` **will and must change** — a generic method is never `toEqualTypeOf`-equal to a non-generic one. Rewrite it to assert the new defaulted (untyped consumer) and narrowed (taxonomy consumer) shapes. Do not treat byte-identical signatures as a constraint; that fights the feature.
- **Reserved page slot (— architect 2026-07-07, Q3):** two mechanisms together — (1) top-level reserved `page?: PropDecl` slot in `TaxonomyDecl` (so typed page-props extend additively later); (2) type-forbid the reserved neutral page name as a consumer `events` key via `& { [K in typeof RESERVED_PAGE_EVENT]?: never }`. Runtime page-ness: **E3 does the reserved-name rename only** — rename `DEFAULT_PAGE_NAME='page'` → `RESERVED_PAGE_EVENT` (the rename and the type-forbid are the same decision, land together). **Defer the structural `NeutralEvent` discriminator to E6**, where page enrichment consumes it; adding a discriminator to the frozen `NeutralEvent` now, with nothing to consume it, is premature.
- **Vendor-neutral trap on the reserved name (— architect 2026-07-07):** posthog-js marks pageviews with the reserved event name `$pageview` — the reference for *what* page-ness is and exactly what NOT to copy. The neutral reserved token must be library-owned, non-`$`, non-colliding, clearly reserved. The literal is a builder naming call within those constraints (the type-level exclusion makes compile-time collision impossible regardless; choose the literal to also minimize runtime collision for untyped consumers).
- **Resolved planning flag — super-props / page-slot props DEFER (PM 2026-07-07):** the first `T` ships `events` / `traits?` / `groups?` + the reserved `page` slot only. The example consumer (Fernly, E10) declares 7 typed events, maps role→trait and workspace/team→`group()`, and uses manual `page()` — but declares NO typed super-properties and NO typed page-specific props. The minimal `T` covers Fernly end-to-end; typed super-props and typed page-slot props stay additive expansions (they extend `T` without moving the S2 guard) until a real consumer needs them.
- **Sub-decision, non-blocking (— architect 2026-07-07):** `props: TX['events'][K]` makes props *required*, forcing `{}` on no-prop events. PM lean: make props optional-when-empty / required-when-declared via a conditional rest-tuple param (ergonomics + safety); acceptable fallback is always-optional `props?`. Builder + architect settle at impl; not a blocker.
- **No posthog-js analogue** for the taxonomy generic — entirely the library's own surface. Ground the TS mechanics in the shipped E2 seam (`analytics-provider.ts`, `neutral-event.ts`, `create-analytics.ts`), not in `posthog-js`.

## Shipped
