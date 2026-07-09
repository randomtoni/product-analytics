---
id: E3-CORE-taxonomy-allowlist
status: done
area: core
touches: [privacy]
api_impact: additive
blocked_by: [E2-CORE-provider-seam]
updated: 2026-07-07
---

# E3-CORE-taxonomy-allowlist — Core mechanisms: typed taxonomy + allowlist enforcement

## Why

The typed-taxonomy mechanism and the payload allowlist are the two "mechanism from the library, contents from the consumer" primitives that make the library both type-safe and privacy-enforcing without baking in any event name. The allowlist is the library's vendor-neutral privacy contract — it must hold identically for every adapter (bar A), so it lives at the facade, never in an adapter.

## Success criteria

- `defineTaxonomy<T>()` returns a **runtime object** (not a bare generic) that carries the event/prop/group declaration at runtime and brands the type — one declaration powers both compile-time typing and the runtime key registry.
- Typing flows through the facade: `track<K extends keyof T['events']>(event: K, props: T['events'][K])`, `group<G>(...)`, `page` as a reserved taxonomy slot, traits via an optional `T['traits']` map.
- The allowlist guard runs at the facade call-boundary, synchronously, **PRE-enrichment**, inside `track`/`page`/`identify`/`group`/`setTraits`; it **throws** on an off-list consumer key by default (`onViolation: 'throw' | 'drop-and-error-log'`, default `throw`). (`page` carries consumer-supplied props and routes through the same capture path, so its props keys are gated identically — architect 2026-07-07, correcting an earlier enumeration that omitted `page`.)
- Library-generated enrichment keys are **implicitly allowed** (added downstream of the guard, inside the adapter); consumer-supplied values (event props, traits, injected enrichment such as the E6 country source) are gated.
- Allowlist source is an explicit `allowlist: string[]` config field with an optional `deriveAllowlistFromTaxonomy(taxonomy)` convenience — kept separable because super-props live outside any single event's taxonomy entry.

## Stories

Dependency shape: a linear chain — **S1 → S2 → S3**. **All three shipped.**

- **[E3-S1](../stories/5-done/E3-S1-define-taxonomy-typed-facade.md)** *(done — `6f58cd6`)* — `defineTaxonomy(decl)` runtime object + `const` type brand; `AnalyticsProvider<TX>` generic (loose default) with typed `track`/`group`/`page`/traits signatures; reserved `page` slot + `RESERVED_PAGE_EVENT`. Bar B (untyped `createAnalytics({}).track('x')`) preserved.
- **[E3-S2](../stories/5-done/E3-S2-allowlist-guard.md)** *(done — `f20745c`)* — the payload-allowlist guard at the facade call-boundary: synchronous, pre-enrichment, gating `track`/`page`/`identify`(both bags)/`group`/`setTraits` prop/trait keys; `allowlist?`/`onViolation?` config (throw by default); opt-in (`allowlist !== undefined` activates, `[]` = allow-nothing). Gates top-level keys (nested-key gating is a future extension).
- **[E3-S3](../stories/5-done/E3-S3-allowlist-source-derivation.md)** *(done — `d0f2aae`)* — `deriveAllowlistFromTaxonomy` (pure helper, consumer-side spread into the single `allowlist`; name-exclusion by construction) + the "library computes ⇒ trusted; consumer supplies ⇒ gated" seam E6's injected country source conforms to.

## Out of scope

- Enrichment itself (page / UTM / device / country) — E6; E3 only fixes that library-computed keys are trusted and consumer-injected values are gated.
- Adapter wire-mapping of the neutral event → vendor shape (E2 SPI / adapters).
- Super-property *registration* mechanics beyond the allowlist's awareness of them (identity / E4 owns registration).

## Notes

- — architect (2026-07-07): `defineTaxonomy<T>()` over a bare generic param — a plain generic gives compile-time safety but types erase at runtime and can't drive the allowlist. The returned value carries the declaration at runtime AND brands the type, so one declaration powers both typing and the runtime key registry. posthog-js has NO taxonomy generic and NO payload allowlist — this is entirely the library's own surface.
- — architect (2026-07-07): The allowlist attaches at the facade call-boundary, BEFORE the adapter and BEFORE enrichment — load-bearing because it's a vendor-neutral privacy contract that must hold identically for every adapter (bar A); it cannot live where each adapter could re-implement or skip it. (PostHog's structurally-similar `before_send` runs AFTER enrichment as a soft mutate/drop hook — `packages/browser/src/posthog-core.ts:1453-1462` — the inverse position and semantics.)
- — architect (2026-07-07): Fail loud — throw on an off-list consumer key by default; `onViolation: 'throw' | 'drop-and-error-log'`, default `throw` per the BRIEF's "fails loudly." Drop-and-log is an opt-in for prod resilience.
- — architect (2026-07-07): Enrichment keys are IMPLICITLY allowed because they're added downstream of the guard (inside the adapter, after the facade allowlist has run) and are each independently opt-out-able in E6. Rule: keys the library **computes** are trusted; keys OR values the consumer **supplies** (event props, traits, injected enrichment) are gated. Exception — the consumer-injected country source (E6) carries consumer data, so its key must be on-list; design this "consumer-supplied value ⇒ gated" path here, not as an E6 afterthought.
- — architect (2026-07-07): Allowlist source = a separate explicit `allowlist: string[]` config field + an optional `deriveAllowlistFromTaxonomy(taxonomy)` convenience; keep them separable because global/registered super-props exist outside any single event's taxonomy entry.
- — architect (2026-07-07, E-cross): Groups typing threads E3↔E6↔E2 — ensure `group()` typing flows through `defineTaxonomy` (E3), the capture path (E6), and the SPI (E2); don't let it fall between the identity and capture epics.
- — planning flag (2026-07-07): the initial `T` shape ships `events` / `traits` / `groups` (+ the reserved `page` slot). Typed **super-properties** and typed **page-slot props** are Expansion-path-additive (below) — they extend `T` without moving the guard. **At story drafting, PM decides whether the first `T` includes them or defers**, checked against the example consumer's (Fernly) needs. Default: **defer** — ship the minimal `T`, add these additively when a real consumer needs them. Not a build blocker; called out so it isn't rediscovered mid-build. **Resolved at drafting (PM, 2026-07-07): DEFER.** The example consumer (Fernly, E10) declares 7 typed `events`, maps role→trait and workspace/team→`group()`, and uses manual `page()` — but declares NO typed super-properties and NO typed page-specific props. The minimal `T` (`events` / `traits?` / `groups?` + reserved `page` slot) covers Fernly end-to-end; typed super-props and typed page-slot props stay additive expansions until a real consumer needs them. Recorded in E3-S1 Technical notes.
- Confidence: high (E3).

## Expansion path

Additional taxonomy dimensions (typed super-props, page-slot props) extend the `T` shape additively; the allowlist derivation grows with the taxonomy without moving the guard's position.
