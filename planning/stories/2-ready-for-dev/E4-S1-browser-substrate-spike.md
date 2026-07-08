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
- **Injectable UUID generator (facade `dedupeId`):** make the seam's `generateUuid` overridable so the browser target can supply a crypto-backed generator instead of the `Math.random()` v4 default; the seam default stays in place as fallback. **Injection seam (pinned — architect 2026-07-08):** thread it as `createAnalytics(config, adapter?, deps?: { generateUuid?: () => string })` → a trailing `AnalyticsProviderImpl` constructor param `generateUuid: () => string = <imported seam default>`, and have `buildEvent` stamp `dedupeId` via that param. Keep it OFF `AnalyticsConfig` (it is first-party wiring after `adapter`, not a consumer product knob — the config surface stays meaning-pure per bar A). This is the ONLY generator injected into the seam; the identity/session **v7** ids are generated inside the browser adapter (next bullet), not injected. No wire mapping (E5).
- **Browser adapter skeleton:** create the first real `@analytics-kit/browser` adapter module — a class implementing the shipped `AnalyticsAdapter` SPI (E2), named by role (never by vendor), with a capture-pipeline skeleton (the hook points S7's super-prop merge + S8's `sessionId` stamp will extend). No identity/persistence feature logic yet (S2–S9).
- **Browser `createAnalytics` entry:** a browser-package `createAnalytics(config)` that constructs the browser adapter when keyed and falls back to the seam `NoopAdapter` when unkeyed, installing the resolved adapter into the seam facade (bar B: config-only, no library edit; unkeyed ⇒ whole-stack no-op).
- **Browser build/test env (real infra — the substrate config edits S2–S9 depend on):** (a) set `environment: 'jsdom'` in `packages/browser/vitest.config.ts` (runtime DOM for tests); (b) add `"lib": ["ES2022", "DOM"]` to `packages/browser/tsconfig.json`'s `compilerOptions` (overrides the base `["ES2022"]`) so `document` / `localStorage` / `window` / `crypto.getRandomValues` typecheck in the browser adapter — **without this the S2–S9 persistence/identity/session code will not `tsc`**; (c) add `jsdom` to `packages/browser/package.json` `devDependencies` (the first per-package test devDep — E1-S3's forward-note that per-package test devDeps arrive at E4; there is no `catalog:` section in `pnpm-workspace.yaml` today, so a catalog entry would first mean adding that section). DOM *types* come from the tsconfig `lib`, not from `@types`. First browser-package story with DOM-touching tests; every later E4/E5/E6 browser story depends on all three.
- **De-branded crypto UUIDv7 utility (identity/session ids):** a browser-package UUIDv7 generator — a de-branded port of posthog-js's `uuidv7` (`posthog-js/packages/browser/src/uuidv7.ts`, the LiosK vendored construction) that S5 (anon/device id) and S8 (session id) consume. **Mechanics (posthog-source-guide-verified 2026-07-08):** v7 is a hand-built construction — a `Date.now()` millisecond timestamp in bytes 0–5 + a monotonic counter + random bits from `crypto.getRandomValues` (with a `Math.random` fallback). It is **NOT** `crypto.randomUUID()` — that primitive returns a v4 (purely random, no time prefix) and structurally cannot back a v7. Requires the `DOM` lib (`crypto.getRandomValues`), landed in the config edits above. Separate from the facade `dedupeId` generator (which may be v4).

### Out

- Persistence store, modes, storage-key naming — **S2**.
- Consent durability, lifecycle-under-opt-out drop semantics — **S3**.
- Any identity / device-id / session / super-prop / reset feature — **S5–S9**.
- The `dedupeId → top-level uuid` wire mapping — **E5**.

## Acceptance criteria

- [ ] The facade's active `adapter` is derived only through `resyncActiveAdapter()`; `installAdapter(next)` sets `liveAdapter` then re-derives; a test proves `installAdapter` → `optOut()` → `optIn()` delegates to the NEW live adapter (no stale ref).
- [ ] `flush()` / `shutdown()` route to `liveAdapter`: a test where the client is opted-out still reaches the live adapter's `flush` / `shutdown` (the E2-S5 shutdown-leak is closed).
- [ ] Capture / identity-mutation verbs still route through `this.adapter` (inert under opt-out) — existing E2 consent tests stay green.
- [ ] `generateUuid` is injectable via `createAnalytics(config, adapter?, deps?: { generateUuid?: () => string })` → facade constructor param; the browser `createAnalytics` supplies a crypto-backed generator; the seam `Math.random` default remains for unconfigured use. No `crypto` reference leaks into the seam package under `lib:["ES2022"]`.
- [ ] `@analytics-kit/browser` exposes `createAnalytics(config)`: keyed ⇒ browser adapter installed; unkeyed ⇒ `NoopAdapter` (zero captures, zero writes).
- [ ] `packages/browser/vitest.config.ts` runs under `environment: 'jsdom'`; `packages/browser/tsconfig.json` sets `lib: ["ES2022","DOM"]`; a DOM-touching test executes AND a browser module referencing `document`/`localStorage`/`crypto.getRandomValues` typechecks; `jsdom` is a resolved dev dependency.
- [ ] `grep -ri posthog packages/browser/src packages/analytics-kit/src` is clean (no vendor names in code / keys / types).
- [ ] `pnpm --filter @analytics-kit/browser` and `--filter analytics-kit` typecheck / lint / test / build all exit 0.

## Technical notes

- **Single-derivation + `installAdapter` (Q5b, — architect 2026-07-08):** `this.adapter` is a pure derivation of (`liveAdapter`, `optedOut`); one private `resyncActiveAdapter()` is the only writer; `installAdapter(next)` sets `liveAdapter` then re-derives. Directly closes the two E2-S5 reviewer forward-notes (stale-ref on opt-out→opt-in; two adapter fields drifting). Consolidate the derivation BEFORE anything post-construction installs an adapter. **Shipped-test hygiene (refiner 2026-07-08):** the E2 test `'the adapter field is reassignable so S4/S5 can swap the active delegate'` (`analytics-provider.test.ts` ~line 216) directly casts-and-writes `this.adapter`, which contradicts the new "written ONLY through `resyncActiveAdapter()`" invariant (it still passes mechanically, but its intent is now stale). Repoint it at the new `installAdapter(next)` path — that swap is what the new AC #1 already exercises. In E4 the browser `createAnalytics` passes the adapter at construction (via the seam `createAnalytics(config, adapter?)` path, since `AnalyticsProviderImpl` is not exported), so `installAdapter` has no production caller yet — it is substrate for the deferred-key case, verified directly by AC #1.
- **Lifecycle routing invariant (Q5b):** identity-read (`getDistinctId`, S5), lifecycle (`flush` / `shutdown`), and `reset` (S9) route through `liveAdapter`; capture / identity-mutation (`track` / `page` / `identify` / `group` / `setTraits` / `register*`) route through the consent-swappable `adapter`. Routing `shutdown()` through the no-op leaked the live adapter's timer/listener (the E2-S5 bug) — fixed here.
- **Injectable UUID (E2-S3 forward note; injection seam pinned by refiner — architect 2026-07-08):** the seam's `generateUuid` is a `Math.random()` v4 UUID because the seam can't reference ambient `crypto` under `lib:["ES2022"]`. E4 makes it injectable and the browser `createAnalytics` supplies a crypto-backed generator for the facade's `dedupeId`. **Pinned seam:** `createAnalytics(config, adapter?, deps?: { generateUuid?: () => string })` threads into a trailing `AnalyticsProviderImpl` constructor param `generateUuid: () => string = <imported seam default>`; `buildEvent` stamps `dedupeId` via that param. Kept OFF `AnalyticsConfig` (first-party wiring after `adapter`, not a consumer product knob — config surface stays meaning-pure per bar A). `dedupeId` needs no time-ordering, so a v4 (even `crypto.randomUUID`) is fine there; the browser adapter's identity/session ids are the SEPARATE UUIDv7 util (which must NOT use `crypto.randomUUID` — that's v4). Wire mapping (`dedupeId`→`uuid`) is E5, out of scope.
- **Decomposition-spike framing (— architect 2026-07-07):** posthog-js's browser core is one ~4,200-line monolith (`posthog-core.ts`); E4/E5/E6 slice the SAME file. Front-load the shared substrate (neutral event object + property-build order + persistence hook points) here so the tracks split cleanly. Port de-branded: no `ph_` / `$` / `posthog` names in the neutral event object or the browser adapter's surface.
- **jsdom + DOM-lib infra (E1-S4 + E1-S1 + E1-S3 forward notes):** the browser package's `vitest.config.ts` currently only merges `vitest.shared` (no `environment`), and its `tsconfig.json` inherits the base `lib:["ES2022"]` with NO DOM. Land BOTH: `environment: 'jsdom'` (runtime) AND `lib:["ES2022","DOM"]` in `packages/browser/tsconfig.json` (types) — E1-S3 explicitly parked "`@analytics-kit/browser` may set `lib:["ES2022","DOM"]` … later (E4)". Add `jsdom` as a browser-package devDep (no `catalog:` section exists in `pnpm-workspace.yaml` today). Real infra E4 must land — S2–S9, E5, E6 all need both a runtime DOM and DOM types.
- **Browser entry / bar B:** the browser `createAnalytics(config)` selects the browser adapter by config (key present) and falls back to `NoopAdapter` when unkeyed — new-app adoption is config-only, no library edit; unkeyed stays a whole-stack no-op (BRIEF §Release-1 posture).
- reference: `posthog-js/packages/browser` (adapter / capture-pipeline shape) + `packages/core` (`uuidv7`); de-brand.

## Shipped

<!-- Empty at draft. /implement-epics fills this once, when the story moves to stories/5-done/
(files changed/added, new public API, tests added, commit, reviewer notes). Do not hand-edit. -->
