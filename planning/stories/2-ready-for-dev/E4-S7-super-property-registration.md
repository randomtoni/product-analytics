---
id: E4-S7-super-property-registration
epic: E4-ID-identity-persistence
status: ready-for-dev
area: identify
touches: [browser, privacy]
depends_on: [E4-S2-persistence-store-modes]
api_impact: additive
---

# E4-S7-super-property-registration — Super-property register / unregister (collapsed once-flag), allowlist-gated at registration

## Why

Super-properties ride on every event, which makes them the one consumer-supplied source that could smuggle PII past the privacy contract. This lands `register(props, { once? })` / `unregister(key)` with the E3 allowlist gate applied at REGISTRATION, so a super-prop key is validated exactly once, on the way in.

## Scope

### In

- Facade super-property registration with the collapsed once-semantics shape (pinned below): public `register(props, options?: { once?: boolean })` + `unregister(key)`, plus matching SPI verbs `register(props, options?: { once?: boolean })` / `unregister(key)` on `AnalyticsAdapter` (NO separate `registerOnce` verb — `once` collapses into the options bag); `NoopAdapter` no-ops them.
- Each consumer-supplied-key facade method runs the shipped E3 `allowed()` guard on the incoming bag BEFORE persisting, reusing the E3 whole-bag drop/throw semantics VERBATIM (first off-list key ⇒ throw by default, or drop-and-error-log) — the same policy path as `track`, not a new one.
- The browser adapter's downstream merge-of-super-props-into-events stays ungated/trusted (everything in super-prop storage already passed the gate on the way in).
- Uses S2's register / register_once / unregister STORAGE mechanics.
- Under opt-out, `register*` routes through the consent-swappable `adapter` ⇒ inert, no persistence write.

### Out

- The storage mechanics themselves — **S2**.
- Event-time super-property application at capture for `group()` typing — **E6**.
- Library-computed keys (session id S8, enrichment E6) — trusted by construction, NOT gated (deliberate exemption).

## Acceptance criteria

- [ ] The facade exposes super-property registration + unregistration; the SPI grows the verbs; `NoopAdapter` satisfies them.
- [ ] A super-prop key NOT on `config.allowlist` ⇒ registration throws (default) or drops-and-error-logs — identical semantics to a `track` off-list key (reuses `allowed()`).
- [ ] An allowed super-prop is persisted (S2) and merged into subsequently captured events WITHOUT being re-gated downstream (no double-gate).
- [ ] `register(props, { once: true })` keeps the first value (first-touch-immutable); `register(props)` overwrites; `unregister(key)` removes.
- [ ] Under opt-out, `register*` writes nothing (routes to the no-op `adapter`).
- [ ] Library-computed keys (a mock downstream-stamped key) are NOT gated — the deliberate exemption holds.
- [ ] jsdom tests; grep clean; both packages' gates green.

## Technical notes

- **Gate at registration, trust downstream (Q6, — architect 2026-07-08):** each consumer-supplied-key method runs `allowed()` on the incoming keys before persisting, then delegates; because stored super-props already passed the gate, the adapter's merge-into-events stays ungated. The "downstream = trusted" exemption applies ONLY to library-computed keys (session id, enrichment), NEVER to consumer super-props. Failing loud at registration names the exact PII source (best DX). Reuses the single `config.allowlist` (E3) — a super-prop key not on the allowlist behaves exactly like an off-list `track` key. **Rejected:** merging super-props downstream as library-trusted (silently auto-trusts consumer PII — the exact failure to avoid).
- **No double-gate, no gap (— architect 2026-07-08):** every consumer-supplied key crosses `allowed()` exactly once — super-props at registration, per-call props/traits at the shipped E3 guard. Registration MUST reuse the shipped whole-bag drop/throw semantics verbatim, not a new policy path.
- **Once-semantics API shape — PINNED (flagged story-time decision, — architect 2026-07-08 leans (ii) at medium-high):** ship **(ii) collapsed `register(props, { once?: boolean })`** as the default, mirroring the shipped `setTraits(traits, once?)` flag idiom so "once" is ONE idiom library-wide; `unregister(key)` stays a distinct inverse either way. The rejected alternative is **(i)** separate `register(props)` / `registerOnce(props)` (mirrors PostHog SOTA + the `identify(id, traits, traitsOnce)` two-bag idiom). **Refiner confirmed (ii) 2026-07-08** — Scope.In, the ACs, and the tests in this story all use the collapsed `register(props, { once?: boolean })` + `unregister(key)`; there is NO separate `registerOnce` verb on the facade or the SPI. The epic's success-criteria/`## Stories` prose still says `register` / `registerOnce` (pre-collapse phrasing) — that does not gate this story.
- **Do NOT ride `setPersistedProperty` for the facade methods (— architect 2026-07-08):** once-semantics + merge-on-capture is stateful behavior, not raw KV; the STORAGE (S2) uses persistence, the FACADE methods carry the gate + semantics.
- **Library-computed-identifier exemption (— architect 2026-07-08):** session id / device id / enrichment leave the app by a DELIBERATE, documented exemption — the allowlist gates consumer-supplied payload (potential PII); library-computed identifiers are trusted by construction. Consumer super-props are the ONE consumer-supplied source flowing downstream into every event, which is exactly why they alone are gated at registration.
- **Public-surface type-pin must be bumped (refiner 2026-07-08):** `register` and `unregister` are NEW public `AnalyticsProvider` members, so the exact-match `keyof AnalyticsProvider` type-pin in `analytics-provider.test.ts` (currently the 13-member union at ~line 310) must grow to 15 (`… | 'register' | 'unregister'`), and the signature-pin block (~line 360) should gain `register`/`unregister` callability pins. Missing this fails `typecheck`/`test`. (`setTraits(traits, once?)` and `identify(id, traits, traitsOnce)` are unchanged — this story adds only the two super-prop methods.)
- **SPI growth touches ALL in-repo adapter implementors (refiner 2026-07-08):** adding required `register` / `unregister` verbs breaks every `AnalyticsAdapter` implementor until updated — `NoopAdapter` plus the five seam test doubles (`RecordingAdapter` ×3 in `analytics-provider.test.ts` / `adapter.test.ts` / `create-analytics.test.ts`, `SpyAdapter` ×2 in `allowlist.test.ts` / `allowlist-guard.test.ts`). Update them in this story to keep the 93 shipped tests typechecking/green.
- reference: `posthog-js/packages/browser` `register` / `register_once`; de-brand.

## Shipped

<!-- Empty at draft. /implement-epics fills this once, when the story moves to stories/5-done/
(files changed/added, new public API, tests added, commit, reviewer notes). Do not hand-edit. -->
