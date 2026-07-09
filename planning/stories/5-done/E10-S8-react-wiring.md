---
id: E10-S8-react-wiring
epic: E10-CORE-example-consumer
status: ready-for-dev
area: core
touches: [example, react]
depends_on: [E10-S1-fernly-scaffold-recording-adapter, E10-S2-fernly-taxonomy-identity-mapping]
api_impact: additive
---

# E10-S8-react-wiring — React binding: provider + useAnalytics + router-driven usePageView

## Why

Exercises E9: the app slice is wired with `@analytics-kit/react` — `AnalyticsClientProvider` + `useAnalytics<TX>()` + a router value threaded into `usePageView`/`page()`. This proves a consumer adopts the React binding config-only (bar B) and codes against the neutral surface, with the framework binding demonstrated as a typecheck-honest, jsdom-exercised slice (no runnable dev server needed).

## Scope

### In

- A `.tsx` app slice (`examples/fernly/src/app/`) wiring `AnalyticsClientProvider` from `@analytics-kit/react`, a Fernly component calling `useAnalytics<ShapeOf<T>>()` and `track`ing a taxonomy-typed event, and `usePageView` driven by a consumer-threaded route value.
- **Demonstrate the route-source contract**: thread a route value into `usePageView(routeKey)` the way a real app would — a comment/snippet showing `usePathname()` (Next app-router) / `router.asPath` (pages) / `useLocation().pathname` (React Router), with the actual slice threading a plain simulated route value (framework-neutral).
- **Both provider branches shown:** the **config-branch** (`<AnalyticsClientProvider config={fernlyConfig}>`) as the zero-boilerplate adoption path (typecheck-honest), AND the **client-branch** (`<AnalyticsClientProvider client={seamMockClient}>`) fed the seam+mock client from S1 — the branch the jsdom test uses so `page()`/`track()` land on the inspectable recording adapter.
- A jsdom / `@testing-library/react` vitest test (mirroring the react package's own test pattern) proving: the provider mounts; `useAnalytics()` resolves the client from context; a simulated route change drives `page()` into the recording adapter; a `track` from a component lands on the stream.

### Out

- A runnable Next/Vite dev server or a real bundler — architect-ruled unnecessary for the bar-B proof (a running app would only prove a framework's bundler, which bar B does not claim). Typecheck-only `.tsx` + a jsdom test is the complete proof.
- The other slices (S3–S7). This story wires React only.
- Any `packages/*` edit.

## Acceptance criteria

- [ ] `AnalyticsClientProvider` is wired via config (config-branch shown/typecheck-honest) and the client-branch is fed the seam+mock client; both type-check against the real `@analytics-kit/react` `dist/*.d.ts`.
- [ ] `useAnalytics<ShapeOf<T>>()` returns the taxonomy-typed client; a `track` from a component type-checks the event name + props.
- [ ] `usePageView` is driven by a consumer-threaded route value; the route-source contract (`usePathname`/`router.asPath`/`useLocation().pathname`) is demonstrated (comment + framework-neutral threaded value).
- [ ] A jsdom `@testing-library/react` test proves the binding is WIRED: mount → `useAnalytics` resolves → simulated route change fires `page()` → lands on the recording adapter; a component `track` lands too.
- [ ] `turbo run typecheck` + `turbo run test` pass for `examples/fernly` (bar B: config-only React adoption, zero `packages/*` change).
- [ ] **Bar-B diff invariant (enforced):** this story's changeset touches only `examples/**` — nothing under `packages/**`, verifiable by diff. If a required capability appears missing, it is a **bar-B failure** — file it as a bug against the owning epic (E2–E9) per the epic Notes; do NOT patch `packages/*` in E10.

## Technical notes

- **Typecheck-only `.tsx` + jsdom test = complete bar-B proof (architect-ruled 2026-07-08).** Typecheck proves WIREABLE; the jsdom test proves WIRED — require BOTH so the slice isn't dead `.tsx` that compiles but never fires. This is the exact pattern `@analytics-kit/react` uses on its own hooks (`packages/react/*.test.tsx`, `environment: 'jsdom'`). Fernly's `package.json` needs the same React/jsdom devDeps (added in S1) and `tsconfig` needs `jsx: react-jsx` + `lib: [...,'DOM']` (S1) — that config is config, so it doesn't threaten bar B.
- **Provider branches (E9 watch-item).** `AnalyticsClientProvider` props are a discriminated `client XOR config` union (`packages/react/src/analytics-client-provider.tsx`). The **config-branch** calls the browser package's `createAnalytics(config)` internally → builds a real `BrowserAdapter`/`NoopAdapter` (NOT the injected mock) — so show it as the zero-boilerplate adoption shape (typecheck-honest; if run, use an unkeyed config so it's a no-op). The **client-branch** is what the jsdom test drives with the seam+mock client from S1 (so captures land on the inspectable recording adapter). This is the clean way to keep the React slice on shape (A).
- **Route-source contract (E9 watch-item, locked).** `usePageView<TX>(routeKey, options?)` fires `page()` on `routeKey` change (`packages/react/src/use-page-view.ts`); it holds NO history listener — the consumer threads the route value. Demonstrate the documented sources (`usePathname()` Next app-router / `router.asPath` pages / `useLocation().pathname` React Router). Keep the actual threaded value framework-neutral (a plain state value) — stronger for a vendor-neutral lib and on-brief ("router-driven `page()`", not "Next-router-driven").
- **`useAnalytics` typing (taxonomy is NOT inferred end-to-end — pin this).** `useAnalytics<TX extends TaxonomyShape>(): RootAnalytics<TX>` (VERIFIED `packages/react/src/use-analytics.ts` — it does `return client as RootAnalytics<TX>`). The provider's `client` prop and the context value are the DEFAULT-shape `RootAnalytics` (VERIFIED `analytics-client-context.ts`), so the taxonomy shape is re-supplied at EACH `useAnalytics<ShapeOf<T>>()` call, not propagated from the provider. Pass `ShapeOf<T>` for the Fernly taxonomy from S2 at every hook call. Sentinel-throws outside a provider.
- **Client-branch = the S1 seam-mock harness.** The jsdom test's `client={...}` is fed the SAME `createFernlyAnalytics(...)` harness from S1 (a `RootAnalytics<ShapeOf<T>>` backed by the `RecordingAdapter`). A `RootAnalytics<ShapeOf<T>>` is assignable to the `client: RootAnalytics` prop (widening to the default shape), so it type-checks cleanly. Because it rides the S1 harness, it inherits S1's granting-consent pin — hooks' `page()`/`track()` land on the inspectable recorder, not the internal noop. Construct the harness KEYED so captures record.
- **Same taxonomy, every surface.** The component's `track` and `usePageView` type off the SAME S2 taxonomy that browser/node/query use.

## Shipped
- > Reviewer suggestion (2026-07-09, improvement-pass): dead import — `fernlyTaxonomy` (value) is imported at `fernly-app.test.tsx:6` but only the TYPE `FernlyTaxonomy` is used → `eslint` error (`'fernlyTaxonomy' is defined but never used`). Drop it to `import { type FernlyTaxonomy } from '../taxonomy';`.
- > Reviewer suggestion (2026-07-09, improvement-pass): `@example/fernly` has NO `lint` script, so `turbo run lint` silently skips the example (which is how the dead import escaped the gate). Add a `lint` script to `examples/fernly/package.json` so the example is genuinely lint-gated + "all four green" is honest for `examples/**` (bar-B-clean — it's an `examples/**` edit). E11 anchors its vendor/product-name scan to `packages/**`; `examples/**` is excluded.

## Shipped

> Captured by `implement-epics` on 2026-07-09. Closes E10 — exercises E9 React binding as a config-only consumer slice (bar B).

- **Files added (examples ONLY — bar B):** `app/fernly-app.tsx` (`ReviewWorkspace` = `useAnalytics<FernlyShape>()` + taxonomy-typed `track('review_requested',…)` + `usePageView<FernlyShape>(route)`; `FernlyAppViaConfig` config-branch [unkeyed no-op]; `FernlyAppViaClient` client-branch [S1 seam-mock harness]; route-source-contract comment) + `.test.tsx` (jsdom)
- **New public API:** none — example-only. ZERO `packages/**` edits (bar B; the S1-added react/jsdom devDeps + tsconfig are config).
- **Both provider branches (E9 watch-item):** config-branch `<AnalyticsClientProvider config={fernlyConfig}>` (unkeyed → browser `createAnalytics` builds internal `NoopAdapter`, genuine no-op, never touches the injected recorder — PROVEN: asserts `key` undefined + mounts-without-throw); client-branch `<AnalyticsClientProvider client={seamMockClient}>` fed the S1 KEYED `createFernlyAnalytics` harness (`RootAnalytics<FernlyShape>` WIDENS to `client: RootAnalytics` — widening verified by the compiler, not just asserted).
- **Typecheck-honest AND jsdom-wired (crux, BOTH required):** (a) `.tsx` typechecks against react `dist/*.d.ts`; the `@ts-expect-error` (unknown event `checkout_started` + wrong prop `reviewerId:42`) genuinely fire. (b) jsdom test: mount→`useAnalytics` resolves→1 `page()` on mount→route CHANGE fires a 2nd `page()` onto the recorder→component `track` lands `review_requested`. No-history-listener pin tested AFFIRMATIVELY (same route re-threaded + raw `pushState`/`popstate` → NO extra page(), stays at 1).
- **useAnalytics taxonomy NOT inferred:** `useAnalytics<FernlyShape>()` re-supplies the shape at each call (context is default-shape; hook does `return client as RootAnalytics<TX>`); wrong event → compile error. Route-source contract (`usePathname`/`router.asPath`/`useLocation().pathname`) shown as a comment, actual value framework-neutral (plain state). Builder self-fixed `autoPageview`→real `CaptureProfile` `{autocapture, enrichment:{page,utm}}` + added `afterEach(cleanup)`.
- **Tests added:** fernly +7 (mount-page + route-change-2nd-page + track-lands, same-route+pushState/popstate-no-extra, config-branch-mounts-no-throw, fernlyConfig-unkeyed, live-mount ties type-block, type-level `@ts-expect-error`×2) → 79 across 10 files; turbo typecheck+test green (9/9 each); bar-B holds
- **Commit:** `E10-S8-react-wiring — React binding: provider + useAnalytics + router-driven usePageView` on `core-cycle`
- **Reviewer notes:** ship-ready — 0 critical, 1 suggestion (dead import + no-lint-script gap — improvement-pass)
- **E10 feature-complete:** all 8 slices wired against the ONE S2 `fernlyTaxonomy`, all bar-B (`examples/**`-only, zero `packages/**`): S1 scaffold+recording-adapter, S2 taxonomy+identity, S3 merge/reset (E4), S4 contexts (E6), S5 allowlist (E3), S6 node (E7), S7 query (E8), S8 react (E9).
