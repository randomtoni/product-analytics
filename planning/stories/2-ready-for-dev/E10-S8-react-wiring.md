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

## Technical notes

- **Typecheck-only `.tsx` + jsdom test = complete bar-B proof (architect-ruled 2026-07-08).** Typecheck proves WIREABLE; the jsdom test proves WIRED — require BOTH so the slice isn't dead `.tsx` that compiles but never fires. This is the exact pattern `@analytics-kit/react` uses on its own hooks (`packages/react/*.test.tsx`, `environment: 'jsdom'`). Fernly's `package.json` needs the same React/jsdom devDeps (added in S1) and `tsconfig` needs `jsx: react-jsx` + `lib: [...,'DOM']` (S1) — that config is config, so it doesn't threaten bar B.
- **Provider branches (E9 watch-item).** `AnalyticsClientProvider` props are a discriminated `client XOR config` union (`packages/react/src/analytics-client-provider.tsx`). The **config-branch** calls the browser package's `createAnalytics(config)` internally → builds a real `BrowserAdapter`/`NoopAdapter` (NOT the injected mock) — so show it as the zero-boilerplate adoption shape (typecheck-honest; if run, use an unkeyed config so it's a no-op). The **client-branch** is what the jsdom test drives with the seam+mock client from S1 (so captures land on the inspectable recording adapter). This is the clean way to keep the React slice on shape (A).
- **Route-source contract (E9 watch-item, locked).** `usePageView<TX>(routeKey, options?)` fires `page()` on `routeKey` change (`packages/react/src/use-page-view.ts`); it holds NO history listener — the consumer threads the route value. Demonstrate the documented sources (`usePathname()` Next app-router / `router.asPath` pages / `useLocation().pathname` React Router). Keep the actual threaded value framework-neutral (a plain state value) — stronger for a vendor-neutral lib and on-brief ("router-driven `page()`", not "Next-router-driven").
- **`useAnalytics` typing.** `useAnalytics<TX extends TaxonomyShape>(): RootAnalytics<TX>` (`packages/react/src/use-analytics.ts`); pass `ShapeOf<T>` for the Fernly taxonomy from S2. Sentinel-throws outside a provider.
- **Same taxonomy, every surface.** The component's `track` and `usePageView` type off the SAME S2 taxonomy that browser/node/query use.

## Shipped
