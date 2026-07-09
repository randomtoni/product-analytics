---
id: E10-S3-cross-subdomain-merge-reset
epic: E10-CORE-example-consumer
status: ready-for-dev
area: core
touches: [example, identify, browser]
depends_on: [E10-S1-fernly-scaffold-recording-adapter, E10-S2-fernly-taxonomy-identity-mapping]
api_impact: additive
---

# E10-S3-cross-subdomain-merge-reset — Cross-subdomain cookie config + simulated marketing→app merge + reset

## Why

Exercises E4 at the neutral seam: a config-supplied `cookieDomain` stitches a marketing-site visit to an app session under one distinct id, a simulated anonymous→identified merge across the two subdomains preserves that id, and `reset()` clears identity. This proves a consumer configures cross-subdomain identity by config alone and that the neutral merge contract holds — the property both acceptance bars depend on.

## Scope

### In

- Config the harness with `cookieDomain: '.fernly.example'` + `crossSubdomainCookie: true` (config-only — proving the surface ACCEPTS them with zero library change).
- Stage a **simulated marketing→app journey** on the shared recording adapter: a `marketing` phase (`fernly.example`) captures anonymous events, then an `app` phase (`app.fernly.example`) `identify`s the reviewer. Assert on the recorded neutral stream that the distinct id is **preserved** across the handoff (the anonymous id links to the identified id — the merge). NOTE: these "phases" are staged sequences of calls on the ONE root harness (`createFernlyAnalytics`), NOT `context()` scoped views — named `context()` profiles are S4's concern. The cross-subdomain merge is modeled purely by the recording adapter's identity state machine, so a plain call sequence on the root is the whole staging.
- A `reset()` assertion: after `reset()`, identity is cleared and a fresh anonymous id is minted (the retained link dropped) — asserted on the stream.
- A runnable vitest test covering: (1) anon events before identify carry the anon id; (2) after identify, the id is preserved / merged; (3) `reset()` re-anonymizes.

### Out

- Real `document.cookie` writes or a real `BrowserAdapter` — the merge is proven at the seam via the recording adapter's modeled identity state machine (S1), NOT by re-running BrowserAdapter's cookie jar. E4-S4/S6 already own the real cookie + `IdentityStore` merge tests.
- Named contexts (S4), allowlist (S5), node/query/react (S6/S7/S8).
- Any `packages/*` edit.

## Acceptance criteria

- [ ] `cookieDomain: '.fernly.example'` + `crossSubdomainCookie` are supplied via config only; harness constructs with zero `packages/*` change.
- [ ] The staged marketing→app handoff preserves the distinct id across subdomains — asserted on the recorded neutral stream (anon id links to the identified id).
- [ ] `reset()` clears identity and re-anonymizes — asserted on the stream.
- [ ] `turbo run typecheck` + `turbo run test` pass for `examples/fernly`.
- [ ] **Bar-B diff invariant (enforced):** this story's changeset touches only `examples/**` — nothing under `packages/**`, verifiable by diff. If a required capability appears missing, it is a **bar-B failure** — file it as a bug against the owning epic (E2–E9) per the epic Notes; do NOT patch `packages/*` in E10.

## Technical notes

- **Shape (A), architect-ruled (2026-07-08): the merge is proven at the SEAM, not via BrowserAdapter.** The real cookie/merge lives in `BrowserAdapter`/`IdentityStore` (E4's turf, already tested — E4-S4 "cross-subdomain one-id," E4-S6 "cross-subdomain one-id + reload survival"). E10 proves the *neutral-seam* merge contract: the `AnalyticsAdapter` SPI's `identify`/`getDistinctId`/`reset` — the contract a future self-hosted adapter must also satisfy. The facade delegates straight through (`AnalyticsProviderImpl.identify → adapter.identify`; `currentDistinctId → liveAdapter.getDistinctId`; `reset → liveAdapter.reset`, `packages/analytics-kit/src/analytics-provider.ts` lines ~180–224, 273, 284), so the recording adapter rides the identical path the real `BrowserAdapter` does.
- **"Simulated" is load-bearing** — epic (2026-07-07): "a simulated anonymous→identified merge across the two subdomains preserves the id." The merge is MODELED at the harness level (the recording adapter's identity state machine from S1) and the two-subdomain handoff is STAGED — assert on the neutral stream, NOT on a cookie's `domain=` attribute. Keep `cookieDomain` in the config because bar B requires the surface to accept it config-only; the proof is one preserved id in the stream.
- **Cross-subdomain = one shared adapter instance.** — architect (2026-07-08): the marketing view and app view share the SAME recording-adapter instance (the way one `.fernly.example` cookie is shared in production). The proof is that the neutral stream carries one id across the handoff.
- **RecordingAdapter fidelity (from S1).** The mock's `identify()` models the three-branch guard (new-id-while-anon → merge; same-id → traits-only; new-id-while-identified → no merge) and `reset()` re-anonymizes — this is what makes these assertions bite rather than pass vacuously.
- **Division of labor (record it):** E4-S4/S6 own the real cookie + `IdentityStore` merge; E10-S3 owns the neutral-seam merge contract as a bar-B proof. Different tests, different layers, no overlap.

## Shipped

## Shipped

> Captured by `implement-epics` on 2026-07-09. Exercises E4's identity merge at the neutral seam (bar-B proof).

- **Files added (examples ONLY — bar B):** `cross-subdomain-merge-reset.test.ts` (5 tests) — **NO source change needed**: the harness already accepts `cookieDomain`/`crossSubdomainCookie` (live-wired via E4-S4, not dead types) + the S1 `RecordingAdapter` already models the merge. That zero-change adoption IS the bar-B claim (surface accepts the config + merge contract holds, zero library/harness change).
- **New public API:** none — example-only. ZERO `packages/**` edits (bar B, strongest form).
- **The merge proof at the NEUTRAL seam:** simulated marketing→app journey on the ONE shared adapter (same cookie); anon events → `identify` → distinct id PRESERVED — asserted on `recorder.merges` (`{anonymousId, identifiedId:'reviewer-42'}`) + the per-event `distinctId` transition `[anon, anon, 'reviewer-42']`, NOT a cookie `domain=` attr (E4-S4/S6's turf). Facade delegates `identify`/`getDistinctId`/`reset` straight through → the recording adapter rides the identical path any adapter (incl. a future self-hosted one) does — proves the SPI contract, not a PostHog cookie mechanic.
- **`reset()` re-anonymizes genuinely:** fresh anon id (`not.toBe` both prior anon AND identified), retained link dropped; the sharpest test — a subsequent `identify` merges from the NEW anon id (full-`merges`-array assertion catches a stale-anon-id bug a loose length check would miss).
- **Tests added:** fernly +5 (config-only acceptance, marketing→app id-preserving merge, pre-identify anon-id, reset re-anonymize, reset-drops-link regression) → 42; turbo typecheck+test green; bar-B holds
- **Commit:** `E10-S3-cross-subdomain-merge-reset — Cross-subdomain cookie config + simulated marketing→app merge + reset` on `core-cycle`
- **Reviewer notes:** ship-ready — 0 critical, 0 suggestions
- **Division of labor:** E4-S4/S6 own the real cookie + `IdentityStore` merge; E10-S3 owns the neutral-seam merge contract as a bar-B proof (different tests, different layers, no overlap).
- **Cross-story seams exposed (S4):** S4 owns named `context()` scoped profiles (`config.contexts` + `analytics.context(name)`) — a DIFFERENT mechanism from S3's staged phases (plain sequential calls on the ONE root harness = shared cookie, NOT `context()`). S4 asserts its scoped views share the SAME identity/session S3 proved threads through the root (cross-context stitching survives).
