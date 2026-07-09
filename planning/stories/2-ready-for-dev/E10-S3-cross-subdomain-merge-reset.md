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
- Stage a **simulated marketing→app journey** on the shared recording adapter: a `marketing` view (`fernly.example`) captures anonymous events, then an `app` view (`app.fernly.example`) `identify`s the reviewer. Assert on the recorded neutral stream that the distinct id is **preserved** across the handoff (the anonymous id links to the identified id — the merge).
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

## Technical notes

- **Shape (A), architect-ruled (2026-07-08): the merge is proven at the SEAM, not via BrowserAdapter.** The real cookie/merge lives in `BrowserAdapter`/`IdentityStore` (E4's turf, already tested — E4-S4 "cross-subdomain one-id," E4-S6 "cross-subdomain one-id + reload survival"). E10 proves the *neutral-seam* merge contract: the `AnalyticsAdapter` SPI's `identify`/`getDistinctId`/`reset` — the contract a future self-hosted adapter must also satisfy. The facade delegates straight through (`AnalyticsProviderImpl.identify → adapter.identify`; `currentDistinctId → liveAdapter.getDistinctId`; `reset → liveAdapter.reset`, `packages/analytics-kit/src/analytics-provider.ts` lines ~180–224, 273, 284), so the recording adapter rides the identical path the real `BrowserAdapter` does.
- **"Simulated" is load-bearing** — epic (2026-07-07): "a simulated anonymous→identified merge across the two subdomains preserves the id." The merge is MODELED at the harness level (the recording adapter's identity state machine from S1) and the two-subdomain handoff is STAGED — assert on the neutral stream, NOT on a cookie's `domain=` attribute. Keep `cookieDomain` in the config because bar B requires the surface to accept it config-only; the proof is one preserved id in the stream.
- **Cross-subdomain = one shared adapter instance.** — architect (2026-07-08): the marketing view and app view share the SAME recording-adapter instance (the way one `.fernly.example` cookie is shared in production). The proof is that the neutral stream carries one id across the handoff.
- **RecordingAdapter fidelity (from S1).** The mock's `identify()` models the three-branch guard (new-id-while-anon → merge; same-id → traits-only; new-id-while-identified → no merge) and `reset()` re-anonymizes — this is what makes these assertions bite rather than pass vacuously.
- **Division of labor (record it):** E4-S4/S6 own the real cookie + `IdentityStore` merge; E10-S3 owns the neutral-seam merge contract as a bar-B proof. Different tests, different layers, no overlap.

## Shipped
