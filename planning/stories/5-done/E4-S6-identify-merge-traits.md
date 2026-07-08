---
id: E4-S6-identify-merge-traits
epic: E4-ID-identity-persistence
status: ready-for-dev
area: identify
touches: [browser]
depends_on: [E4-S5-anonymous-id-identity-resolver]
api_impact: additive
---

# E4-S6-identify-merge-traits — Client-side anon→identified merge (rides identify()) + traits / traitsOnce

## Why

`identify()` binds the anonymous actor to a stable id and merges their pre-login history — client-side, guarded, exactly once. This lands the merge (riding the existing `identify()` verb, NOT `alias`) with the mutable-vs-first-touch traits split.

## Scope

### In

- Client-side anon→identified merge in the browser adapter's `identify()`: merge ONLY when the id differs AND the actor is still anonymous; same-id re-identify updates traits only; already-identified + new id does NOT merge.
- The merge rides the existing SPI `identify()` verb (E2) — NO new facade `alias()` method, NO adapter alias implementation. The facade's `identify()` keeps delegating straight to `adapter.identify(...)`; the browser adapter grows the de-branded guard.
- Retain the prior anonymous id at merge time (not just swap) so a later in-flight call keeps the merge linkage — [WIRE] retention stays adapter-internal.
- `traits` (mutable) vs `traitsOnce` (first-touch-immutable) following register / register_once semantics.
- The `anonymous → identified` state transition on a successful identify (S5's adapter-internal state).

### Out

- `alias()` implementation (aliasing two known ids) — later slice.
- Server-side identity merge (identified→identified) — not release 1.
- Super-property registration — **S7**.

## Acceptance criteria

- [ ] identify with a NEW id while anonymous performs the merge and transitions state to identified.
- [ ] identify with the SAME id updates traits only (no re-merge).
- [ ] identify with a new id while ALREADY identified does NOT merge client-side.
- [ ] The merge carries the retained prior anonymous id (adapter-internal [WIRE] payload, e.g. de-branded `$anon_distinct_id`); no `$`-prefixed name on any neutral surface.
- [ ] `traits` are mutable (overwrite); `traitsOnce` are first-touch-immutable (kept on repeat).
- [ ] No facade `alias()` method exists and no adapter alias impl was added; the facade `identify()` delegates unchanged.
- [ ] A simulated cross-subdomain journey (S4) + identify keeps ONE merged distinct id; jsdom tests; grep clean; both packages' gates green.

## Technical notes

- **Merge rides `identify()`, not `alias()`; guard in the adapter (Q2, — architect 2026-07-08, source-confirmed):** PostHog emits the merge inside `identify()` as a capture carrying `$anon_distinct_id` (`posthog-core.ts:2552-2570`, stamp at `:2570`; prior-id link core `:363,374`); `alias` is an unrelated link-two-known-ids op. The facade's `identify()` keeps delegating straight to `adapter.identify(...)`; the adapter grows the de-branded guard (differs+anonymous ⇒ merge; same id ⇒ traits-only; already-identified+new id ⇒ no merge).
- **Gated on S5's resolver (Q2 cross-dependency):** `setTraits` → `adapter.identify(currentDistinctId(), ...)`, so with S5's stub returning `'anonymous'` the merge could mis-fire; S5 ships first.
- **Retain, don't swap (— architect 2026-07-08):** persist the previous distinct id AS the anonymous id at `identify()` (`posthog-core.ts:374`) so a later feature-flag-bootstrap slice inherits the linkage rather than rediscovering it.
- **Client-side only (— architect 2026-07-07):** no server-side merge this release.
- **No new SPI verb (Q2):** the merge rides the existing `identify()` — no adapter-contract growth here. (So this story does NOT touch the SPI or the seam test doubles — unlike S3/S5/S7/S9.)
- **Cross-subdomain AC assumes S4 (refiner 2026-07-08):** AC #7's cross-subdomain-journey check relies on S4's shared identity cookie. `depends_on` lists only S5 (the merge's hard dep), but the locked build order (`… → S4 → S6 → S9`) sequences S4 before S6, so S4 is shipped by the time this lands and the AC is satisfiable. If S6 is ever pulled ahead of S4, drop the cross-subdomain clause to the merge-only assertion (identify keeps ONE distinct id within a single context).
- reference: `posthog-js/packages/browser/posthog-core.ts` `identify()` + `packages/core`; de-brand.
- **traitsOnce = wire contract (reviewer-concurred, — architect 2026-07-08):** `traits`/`traitsOnce` ride the identify/merge event as de-branded `set_traits`/`set_traits_once` bags, persisting NOTHING client-side. `traitsOnce` "kept on repeat" is a WIRE `$set_once` contract resolved by the downstream person-props layer (E5+/server) — matches posthog-js exactly (it re-emits `$set_once` on every identify, no client dedupe). Deliberately keeps person-traits OFF the every-event super-prop path (Q6). Within a call, `traits` wins on key collision (register precedence — the only precedence the client can authoritatively resolve).
- > Reviewer suggestion (2026-07-08, improvement-pass candidate): `buildMergeEvent` calls `this.traitBags(...)` twice (spreads `buildTraitsEvent` then overwrites `properties` re-deriving the bags). Correct + cheap but redundant — compose from one shared `traitBags` local.
- > Reviewer note (2026-07-08, for E5): `MERGE_EVENT` value is the literal `'identify'` (de-brands to the vendor merge event downstream). No collision today (adapter-emitted, never consumer-typed). E5's wire-mapper must key off the adapter-emitted `MERGE_EVENT`, not a consumer `track('identify')` string, so the two can't conflate. Also document that `traitsOnce` immutability is a wire/server contract so a later slice doesn't "fix" the every-identify re-emit with client dedupe.

## Shipped

> Captured by `implement-epics` on 2026-07-08.

- **Files changed (browser-only):** `browser-adapter.ts` (three-branch merge guard in `identify()` + merge/traits event builders via `capture()`), `identity-store.ts` (`merge(distinctId)`: snapshot prior → lockstep cache+persist swap → retain prior anon id → flip state → return link), `persistence-keys.ts` (de-branded `MERGE_EVENT`/`SET_TRAITS_KEY`/`SET_TRAITS_ONCE_KEY`)
- **New public API:** none — merge rides the existing `identify()` SPI verb; seam UNCHANGED (no SPI growth, no test-double edits, both bars trivially preserved)
- **Tests added:** browser +18 (3 branches + no-op bare re-identify; retain-prior-anon-id [WIRE] + no-`$`; merge-link can't ride a later event; traits/traitsOnce bags + collision precedence + copy-not-alias; cross-subdomain one-id; reload survival) → 165; seam 126 (unchanged)
- **Commit:** `E4-S6-identify-merge-traits — Client-side anon→identified merge (rides identify()) + traits / traitsOnce` on `core-cycle`
- **Reviewer notes:** 0 critical, 2 suggestions + concurred traitsOnce verdict → see Technical notes
- **Cross-story seams exposed (S9 reset):** `reset()` must re-anonymize — regenerate the anon distinct id (fresh v7) updating cache+`DISTINCT_ID_KEY` in lockstep, flip state back to `anonymous`, CLEAR the retained `ANONYMOUS_DISTINCT_ID_KEY` (S6 sets it at merge — a stale link must not survive logout), keep `DEVICE_ID_KEY` unless `resetDevice`. Natural home: a new `IdentityStore.reset(options?)` sibling to `merge()` (it owns the cache↔persistence lockstep + state field).

<!-- Empty at draft. /implement-epics fills this once, when the story moves to stories/5-done/
(files changed/added, new public API, tests added, commit, reviewer notes). Do not hand-edit. -->

## Follow-up

> E4 post-close improvement pass, 2026-07-08 (commit follows). Reviewer-verified, no regression.

- **Deduped `traitBags()`** — `buildMergeEvent` computes the trait bags once instead of re-deriving them (behavior-preserving). (Addresses S6 reviewer suggestion.)
- Skipped-with-reason: the `MERGE_EVENT='identify'` collision note is a forward note for E5's wire-mapper.
