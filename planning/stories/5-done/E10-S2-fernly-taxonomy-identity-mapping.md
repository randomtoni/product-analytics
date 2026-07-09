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
- [ ] **Bar-B diff invariant (enforced):** this story's changeset touches only `examples/**` (and, if needed, `pnpm-workspace.yaml`) — nothing under `packages/**`, verifiable by diff. If a required capability appears missing, it is a **bar-B failure** — file it as a bug against the owning epic (E2–E9) per the epic Notes; do NOT patch `packages/*` in E10.

## Technical notes

- **`defineTaxonomy` + `ShapeOf` are the mechanism (E3).** `packages/analytics-kit/src/taxonomy.ts` — `defineTaxonomy<const T extends TaxonomyDecl>(decl)` returns `Taxonomy<T>`; the seam/browser/node/query factories all overload on `config & { taxonomy: Taxonomy<T> }` to yield `...<ShapeOf<T>>`. Prop tags are `'string'|'number'|'boolean'|'date'`. Reserved event names `page`/`pageleave` are typed-out of `events` — do NOT declare them.
- **One taxonomy, every surface (locked demonstration).** This same `Taxonomy<T>` object flows into: browser `track`/`page`/`group` (S3/S4/S8 via the harness), node `capture`/`setTraits`/`setGroupTraits` (S6), react `useAnalytics<ShapeOf<T>>()` (S8), and query `funnel`/`retention`/`trend`/`uniqueCount` step/event names (S7). S6/S7/S8 IMPORT this file — keep it the single taxonomy source.
- **Identity is generic (BRIEF).** distinct id + traits + groups; no actor-role notion in the lib. `identify(id, traits, traitsOnce)` — `traits` mutable, `traitsOnce` immutable first-touch. `group(type, key, props)` for workspace/team cohorts. Map Fernly's role as a trait or event prop, not a library concept.
- **Assert on the seam stream.** The harness's `RecordingAdapter` (S1) records `identify(id, traits, traitsOnce)`, `group(type, key, props)`, and — for `setTraits` — routes through `identify`: `setTraits(traits)` (default `once=false`) → `adapter.identify(currentDistinctId, traits)`; `setTraits(traits, true)` → `adapter.identify(currentDistinctId, undefined, traits)` (VERIFIED `AnalyticsProviderImpl.setTraits`, `packages/analytics-kit/src/analytics-provider.ts` ~lines 190–197). Assert against these neutral calls. There is no separate `setTraits` verb on the adapter SPI — it is always an `identify` on the current distinct id.
- **Recording depends on a granting consent posture (from S1).** For these stream assertions to bite (not see an empty stream), the keyed harness must be constructed with the granting posture S1 pins — the `RecordingAdapter.getConsentState()` returns `'granted'` (or the config sets `consentDefault: 'granted'`). Otherwise the facade swaps to its internal noop at construction and records nothing. Inherit S1's decision; do not re-decide it here.

## Shipped
- > Reviewer suggestion (2026-07-09, cosmetic): the "carries a role as an event prop" test uses `review_requested` with `documentId`/`reviewerId` (neither is `role`) — retitle to "carries consumer props on a captured event" OR declare a `role` event prop and assert it flows, so the assertion matches its claim.
- > Reviewer suggestion (2026-07-09): `plan` lives as both a trait AND event props (`fromPlan`/`toPlan`) — legitimate (different surfaces), but a one-line intent note on the spine taxonomy would stop S6/S7/S8 "de-duplicating" them.

## Shipped

> Captured by `implement-epics` on 2026-07-09. The shared taxonomy/identity spine.

- **Files added (examples ONLY — bar B):** `taxonomy.ts` (`defineTaxonomy` — Fernly's 7 events `signup_started`/`signup_completed`/`document_uploaded`/`review_requested`/`comment_added`/`review_completed`/`plan_upgraded` + `role`/`plan`/`email` traits + `workspace`/`team` groups + page props; exports `fernlyTaxonomy` value + `FernlyTaxonomy` type — the SINGLE source) + `taxonomy.test.ts` + `identity-mapping.test.ts`
- **Files changed (examples):** `harness.ts` (`createFernlyAnalytics` now GENERIC over taxonomy — `{taxonomy}` overload → its own `ShapeOf`, default overload → `fernlyTaxonomy`; mirrors the library's `createAnalytics` overload pair; S1's call sites still compile, now typed → `RootAnalytics<ShapeOf<T>>`), `index.ts` (barrel + `fernlyTaxonomy`/`FernlyTaxonomy`)
- **New public API:** none — example-only. ZERO `packages/**` edits (bar B). Library ships zero product concepts (all events/traits/groups consumer-side).
- **Verified:** one-taxonomy-every-surface spine (S6/S7/S8 import `fernlyTaxonomy`); type safety genuine (9 `@ts-expect-error` firing — required-props/wrong-type/unknown-event/reserved-pageleave-out/wrong-trait/unknown-group/wrong-group-prop/wrong-page-prop); **identity mapping onto NEUTRAL primitives** verified against library source — reviewer→`identify(id,traits,traitsOnce)`, workspace/team→`group`, role→`setTraits`(→`identify`)/event-prop; **`setTraits`→`identify` routing** bit-for-bit (`setTraits(traits)`→`identify(id,traits)`; `setTraits(traits,true)`→`identify(id,undefined,traits)`; no `setTraits` adapter verb); recording bites under granting-consent + unkeyed no-op regression pin
- **Tests added:** fernly +16 (taxonomy 9 type + identity-mapping 7 runtime: reviewer/workspace/team/role mapping, setTraits→identify both branches, event-prop, full anonymous→identify→group→group→track journey with per-event distinct-id transition, unkeyed no-op) → 37; turbo typecheck+test green; bar-B holds
- **Commit:** `E10-S2-fernly-taxonomy-identity-mapping — Fernly taxonomy + identity mapping onto the neutral primitives` on `core-cycle`
- **Reviewer notes:** ship-ready — 0 critical, 2 cosmetic suggestions
- **Cross-story seams exposed:** S3–S8 import `{ fernlyTaxonomy }`(value) + `{ FernlyTaxonomy }`(type) from `@example/fernly`/`taxonomy.ts` — single source, don't redeclare. Typed harness `createFernlyAnalytics()` → `RootAnalytics<ShapeOf<FernlyTaxonomy['decl']>>`. **S3** drives the identity state machine (`recorder.merges`); **S6/S7** use this taxonomy + `config.fetch` mock (not the harness adapter); **S8** feeds the typed harness into `AnalyticsClientProvider`.

## Follow-up

> E10 post-close improvement pass, 2026-07-09 (commit follows). Reviewer-verified, behavior-preserving.

- **Test-title accuracy** — `identity-mapping.test.ts` retitled "carries a role as an event prop…" → "carries consumer-defined props on a captured event, not a library concept" (the test uses `review_requested` with `documentId`/`reviewerId`, neither a `role`, so the old title overclaimed). No assertion changed. (Addresses the S2 cosmetic test-title suggestion.)
- Skipped-with-reason: S2 `plan`-in-both-places intent comment (zero-comment default; downstream S6/S7/S8 shipped without the guarded-against de-duplication). Superseded elsewhere: S1 injectable `generateId`/raw-reset-options (S3 made its assertions deterministic without them); S6 `ShapeOf` indirect-derivation (S7 reviewer praised the same drift-proof idiom) + `FetchLike` cast (inherent to the public seam type); S5 comment-only notes.
