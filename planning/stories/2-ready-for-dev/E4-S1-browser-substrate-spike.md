---
id: E4-S1-browser-substrate-spike
epic: E4-ID-identity-persistence
status: ready-for-dev
area: identify
touches: [browser]
depends_on: []
api_impact: additive
---

# E4-S1-browser-substrate-spike — Shared browser substrate + seam consolidation + injectable UUID + jsdom env

## Why

The first target-package epic can't land any identity/persistence feature until the shared browser substrate exists and the facade's adapter-swap plumbing is consolidated. This foundational spike carves the neutral-event / property-build / persistence substrate out of posthog-js's browser monolith into a real `@analytics-kit/browser` adapter + entry, lands the two E2-S5 forward-note fixes (single derivation method + lifecycle→liveAdapter routing), makes the seam's UUID generator injectable, and stands up the browser test env — so S2–S9 (and E5/E6) have a place to build.

## Scope

### In

- **Seam field-derivation consolidation (fixes E2-S5 forward notes):** in `packages/analytics-kit/src/analytics-provider.ts`, make `this.adapter` a pure derivation of (`liveAdapter`, `optedOut`) written ONLY through one private `resyncActiveAdapter()`; add a post-construction `installAdapter(next: AnalyticsAdapter)` that sets `liveAdapter` then re-derives — so `optOut()→optIn()` can never restore a stale ref.
- **Lifecycle routing to the live adapter (fixes the E2-S5 shutdown-leak):** route `flush()` / `shutdown()` through `this.liveAdapter`, not the consent-swapped `this.adapter`. Capture / identity-mutation verbs stay on `this.adapter`. Pin the routing invariant in code (`reset()`→`liveAdapter` lands in S9).
- **Injectable UUID generator:** make the seam's `generateUuid` overridable so the browser target can supply a crypto-backed generator instead of the `Math.random()` v4 default; the seam default stays in place as fallback. No wire mapping (E5).
- **Browser adapter skeleton:** create the first real `@analytics-kit/browser` adapter module — a class implementing the shipped `AnalyticsAdapter` SPI (E2), named by role (never by vendor), with a capture-pipeline skeleton (the hook points S7's super-prop merge + S8's `sessionId` stamp will extend). No identity/persistence feature logic yet (S2–S9).
- **Browser `createAnalytics` entry:** a browser-package `createAnalytics(config)` that constructs the browser adapter when keyed and falls back to the seam `NoopAdapter` when unkeyed, installing the resolved adapter into the seam facade (bar B: config-only, no library edit; unkeyed ⇒ whole-stack no-op).
- **Browser test env (real infra):** set `environment: 'jsdom'` in `packages/browser/vitest.config.ts` and add `jsdom` as a `@analytics-kit/browser` dev dependency (or a workspace `catalog:` entry). First browser-package story with DOM-touching tests; every later E4/E5/E6 browser story depends on it.
- **De-branded crypto UUIDv7 utility:** a browser-package UUIDv7 generator (de-branded port of posthog-js's `uuidv7`, backed by `crypto.randomUUID`/crypto where available) that S5 (anon/device id) and S8 (session id) consume.

### Out

- Persistence store, modes, storage-key naming — **S2**.
- Consent durability, lifecycle-under-opt-out drop semantics — **S3**.
- Any identity / device-id / session / super-prop / reset feature — **S5–S9**.
- The `dedupeId → top-level uuid` wire mapping — **E5**.

## Acceptance criteria

- [ ] The facade's active `adapter` is derived only through `resyncActiveAdapter()`; `installAdapter(next)` sets `liveAdapter` then re-derives; a test proves `installAdapter` → `optOut()` → `optIn()` delegates to the NEW live adapter (no stale ref).
- [ ] `flush()` / `shutdown()` route to `liveAdapter`: a test where the client is opted-out still reaches the live adapter's `flush` / `shutdown` (the E2-S5 shutdown-leak is closed).
- [ ] Capture / identity-mutation verbs still route through `this.adapter` (inert under opt-out) — existing E2 consent tests stay green.
- [ ] `generateUuid` is injectable: the browser adapter supplies a crypto-backed generator; the seam default remains for unconfigured use. No `crypto` reference leaks into the seam package under `lib:["ES2022"]`.
- [ ] `@analytics-kit/browser` exposes `createAnalytics(config)`: keyed ⇒ browser adapter installed; unkeyed ⇒ `NoopAdapter` (zero captures, zero writes).
- [ ] `packages/browser/vitest.config.ts` runs under `environment: 'jsdom'`; a DOM-touching test executes; `jsdom` is a resolved dev dependency.
- [ ] `grep -ri posthog packages/browser/src packages/analytics-kit/src` is clean (no vendor names in code / keys / types).
- [ ] `pnpm --filter @analytics-kit/browser` and `--filter analytics-kit` typecheck / lint / test / build all exit 0.

## Technical notes

- **Single-derivation + `installAdapter` (Q5b, — architect 2026-07-08):** `this.adapter` is a pure derivation of (`liveAdapter`, `optedOut`); one private `resyncActiveAdapter()` is the only writer; `installAdapter(next)` sets `liveAdapter` then re-derives. Directly closes the two E2-S5 reviewer forward-notes (stale-ref on opt-out→opt-in; two adapter fields drifting). Consolidate the derivation BEFORE anything post-construction installs an adapter.
- **Lifecycle routing invariant (Q5b):** identity-read (`getDistinctId`, S5), lifecycle (`flush` / `shutdown`), and `reset` (S9) route through `liveAdapter`; capture / identity-mutation (`track` / `page` / `identify` / `group` / `setTraits` / `register*`) route through the consent-swappable `adapter`. Routing `shutdown()` through the no-op leaked the live adapter's timer/listener (the E2-S5 bug) — fixed here.
- **Injectable UUID (E2-S3 forward note):** the seam's `generateUuid` is a `Math.random()` v4 UUID because the seam can't reference ambient `crypto` under `lib:["ES2022"]`. The browser target HAS `crypto.randomUUID` at runtime — E4 makes the generator injectable/overridable and the browser adapter supplies a crypto-backed UUIDv7. Keep it injectable, not hard-wired. The exact injection seam (facade constructor param vs adapter-owned generators) is a code-shape call for the story-refiner/builder — consult `architect` at build if unclear. Wire mapping (`dedupeId`→`uuid`) is E5, out of scope.
- **Decomposition-spike framing (— architect 2026-07-07):** posthog-js's browser core is one ~4,200-line monolith (`posthog-core.ts`); E4/E5/E6 slice the SAME file. Front-load the shared substrate (neutral event object + property-build order + persistence hook points) here so the tracks split cleanly. Port de-branded: no `ph_` / `$` / `posthog` names in the neutral event object or the browser adapter's surface.
- **jsdom infra (E1-S4 + E1-S1 forward notes):** the browser package's `vitest.config.ts` currently only merges `vitest.shared` (no `environment`). Set `environment: 'jsdom'` and add `jsdom` as a browser-package devDep (or a workspace `catalog:` entry). Real infra E4 must land — S2–S9, E5, E6 all need a DOM.
- **Browser entry / bar B:** the browser `createAnalytics(config)` selects the browser adapter by config (key present) and falls back to `NoopAdapter` when unkeyed — new-app adoption is config-only, no library edit; unkeyed stays a whole-stack no-op (BRIEF §Release-1 posture).
- reference: `posthog-js/packages/browser` (adapter / capture-pipeline shape) + `packages/core` (`uuidv7`); de-brand.

## Shipped

<!-- Empty at draft. /implement-epics fills this once, when the story moves to stories/5-done/
(files changed/added, new public API, tests added, commit, reviewer notes). Do not hand-edit. -->
