---
id: E10-S2-fernly-taxonomy-identity-mapping
epic: E10-CORE-example-consumer
status: ready-for-dev
area: core
touches: [example, identify]
depends_on: [E10-S1-fernly-scaffold-recording-adapter]
api_impact: additive
---

# E10-S2-fernly-taxonomy-identity-mapping — Fernly taxonomy + identity mapping onto the neutral primitives

## Why

Bar B's core claim is that a consumer declares its OWN events and actor model through config + generics, and the library ships zero product concepts. This story declares Fernly's taxonomy via `defineTaxonomy<T>()` and maps Fernly's actor model (reviewer / workspace / team / role) onto the neutral `identify`/`group`/`setTraits` primitives — the one taxonomy that every later slice (browser `track`, node `capture`, react `useAnalytics`, query `funnel`) types off. It is the shared spine of the epic.

## Scope

### In

- A `defineTaxonomy<T>()` declaration (`examples/fernly/src/taxonomy.ts`) of Fernly's events with per-event prop types: `signup_started`, `signup_completed`, `document_uploaded`, `review_requested`, `comment_added`, `review_completed`, `plan_upgraded`. Declare `traits` (e.g. `role`, `plan`, `email`), `groups` (`workspace`, `team`), and a `page` prop shape. The library ships zero event names — all live here.
- Thread the taxonomy through the harness so `createFernlyAnalytics(...)` returns a `RootAnalytics<ShapeOf<T>>` — `track`/`page`/`group`/`identify`/`setTraits` are all taxonomy-typed. A vitest test (or a type-level `expectTypeOf`) proves a wrong-typed prop / unknown event name is a type error.
- **Identity mapping** through the neutral primitives ONLY: reviewer → distinct id via `identify(id, traits, traitsOnce)`; workspace → `group('workspace', key, props)`; team → `group('team', key, props)`; role → a trait/prop (`setTraits({ role })` or an event prop). Assert on the recorded stream that each maps to the expected neutral call. The library carries no notion of Fernly's roles.
- A runnable vitest test exercising a small identity journey (anonymous → `identify` → `group('workspace')` → `group('team')` → a couple of `track`s) and asserting the recorded neutral calls.

### Out

- The cross-subdomain merge + reset (S3), contexts (S4), allowlist assertion (S5). This story establishes the taxonomy + identity mapping and its typed flow; it does NOT add the merge/reset/context/allowlist assertions.
- The node/query/react surfaces (S6/S7/S8) — they consume THIS taxonomy, but their wiring is their own stories.
- Any `packages/*` edit.

## Acceptance criteria

- [ ] `examples/fernly/src/taxonomy.ts` declares Fernly's 7 events + traits + `workspace`/`team` groups + page props via `defineTaxonomy<T>()`; zero event names live in `packages/*`.
- [ ] The harness returns a taxonomy-typed `RootAnalytics<ShapeOf<T>>`; a wrong-typed prop or unknown event name is a compile error (proven by a type test).
- [ ] Reviewer/workspace/team/role map onto `identify`/`group`/`setTraits`/event-props only — asserted on the recording adapter's captured stream.
- [ ] `turbo run typecheck` + `turbo run test` pass for `examples/fernly` (bar B: config + generics only, zero `packages/*` change).

## Technical notes

- **`defineTaxonomy` + `ShapeOf` are the mechanism (E3).** `packages/analytics-kit/src/taxonomy.ts` — `defineTaxonomy<const T extends TaxonomyDecl>(decl)` returns `Taxonomy<T>`; the seam/browser/node/query factories all overload on `config & { taxonomy: Taxonomy<T> }` to yield `...<ShapeOf<T>>`. Prop tags are `'string'|'number'|'boolean'|'date'`. Reserved event names `page`/`pageleave` are typed-out of `events` — do NOT declare them.
- **One taxonomy, every surface (locked demonstration).** This same `Taxonomy<T>` object flows into: browser `track`/`page`/`group` (S3/S4/S8 via the harness), node `capture`/`setTraits`/`setGroupTraits` (S6), react `useAnalytics<ShapeOf<T>>()` (S8), and query `funnel`/`retention`/`trend`/`uniqueCount` step/event names (S7). S6/S7/S8 IMPORT this file — keep it the single taxonomy source.
- **Identity is generic (BRIEF).** distinct id + traits + groups; no actor-role notion in the lib. `identify(id, traits, traitsOnce)` — `traits` mutable, `traitsOnce` immutable first-touch. `group(type, key, props)` for workspace/team cohorts. Map Fernly's role as a trait or event prop, not a library concept.
- **Assert on the seam stream.** The harness's `RecordingAdapter` (S1) records `identify(id, traits, traitsOnce)`, `group(type, key, props)`, and `identify(distinctId, undefined, once)` (which is how `setTraits(traits, once=true)` routes — see `AnalyticsProviderImpl.setTraits`, `packages/analytics-kit/src/analytics-provider.ts`). Assert against these neutral calls.

## Shipped
