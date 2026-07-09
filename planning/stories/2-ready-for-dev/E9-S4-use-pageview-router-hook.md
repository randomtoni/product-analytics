---
id: E9-S4-use-pageview-router-hook
epic: E9-RCT-react-binding
status: ready-for-dev
area: react
touches: [react]
depends_on: [E9-S3-use-analytics-hook]
api_impact: additive
---

# E9-S4-use-pageview-router-hook — optional `usePageView()` router helper

## Why

Pageviews are manual/router-driven in this library (no auto history-listener — BRIEF §1). This optional hook is the ergonomic bridge: a consumer calls it on route change and it delegates to the client's manual `page()`, so React/Next consumers get pageview capture without the provider auto-capturing anything. Opt-in and thin.

## Scope

### In

- **`usePageView(...)`** — a single thin hook that calls `useAnalytics().page(...)` when the route changes. It is **fully opt-in** (a consumer who never calls it gets no pageviews) and delegates entirely to the manual `page()` verb — no new capture path.
- **Router-agnostic / framework-safe**: the hook does NOT hardcode Next's router or React Router. The consumer supplies the current route/path (and optional page name / props) — e.g. `usePageView(pathname)` where the consumer passes the value from `usePathname()` (Next app router), `router.asPath` (Next pages router), or `useLocation().pathname` (React Router). The hook fires `page()` on a `useEffect` keyed on that value, so a change → one `page()` call. First mount → one initial `page()` (matching SPA-pageview expectations); document/allow suppressing the initial fire via an option if trivial.
- **Manual/router-driven, never auto-history**: the hook installs NO global `history`/`popstate`/`pushState` listener. It reacts to the value the consumer threads in from their router. (This is the neutral realization of posthog's history-based SPA pageview — but driven by React router state, not by patching `history`.)
- Signature shape (builder settles exact form): `usePageView(routeKey: string | undefined, options?: { name?: string; props?: ...; captureOnMount?: boolean })` — fires `page(options?.name, options?.props)` whenever `routeKey` changes (and on mount unless `captureOnMount === false`). Taxonomy typing on `props` flows from the `useAnalytics<TX>()` it calls.
- Export `usePageView` from `src/index.ts`.

### Out

- **Any App-Router / Pages-Router adapter layer** — no framework-specific wrapper that reads Next's router internally. That stays deferred (epic Expansion path: "a richer router integration extends this additively, still delegating to manual `page()`"). R1 ships ONE router-agnostic hook.
- **Auto-pageview inside the provider** — the provider (S2) captures nothing; this hook is separate and opt-in.
- **A `usePageLeave` hook** — pageleave is adapter-internal (E6, driven by the browser client's own unload handling), not a React hook this release. (posthog-js has no react `usePageLeave` either; do not invent one.)
- Reading `window.location` directly inside the hook as the route source — the consumer threads the route in from their router (SSR-safe; no DOM read at render).

## Acceptance criteria

- [ ] Calling `usePageView(path)` fires exactly one `page()` on mount and one on each `path` change — asserted with a recording/mock client via `renderHook` + rerender.
- [ ] The hook installs NO global history/popstate listener (a test asserts no `page()` fires from a raw `history.pushState` when the `path` arg is unchanged) — it is purely driven by the value the consumer threads in.
- [ ] `captureOnMount: false` (if implemented) suppresses the initial fire; default fires on mount.
- [ ] `props` (and optional `name`) type-check against the consumer's taxonomy via the `useAnalytics<TX>()` it delegates to.
- [ ] SSR-safe: the hook reads no DOM at render/module time; the effect (client-only) drives the `page()` call — importing/rendering it in an SSR pass initializes nothing.
- [ ] Bar A: swapping the backend adapter needs zero change to a component using `usePageView` (it delegates to the neutral `page()`).
- [ ] Frozen-15 held: the hook calls the existing `page()` verb; it adds no facade verb.
- [ ] Zero vendor references in the hook name or signature.

## Technical notes

- **No posthog-js react source to de-brand** — confirmed: `posthog-js/packages/react/src` has NO pageview/`usePageLeave` hook (verified by grep). PostHog's SPA pageview lives in the **browser SDK** (history patching / autocapture), not the react package. So this hook is a NET-NEW neutral helper realizing the manual `page()` semantics (E6 / BRIEF §1) as a React ergonomic — NOT a shape-for-shape port. Ground the `page()` semantics in the browser client's `page(name?, props?)` verb (shipped, E6) and the seam's `AnalyticsProvider.page` signature.
- **Manual/router-driven stance** — epic Out of scope + BRIEF §1: `page()` stays manual/router-driven; the provider auto-captures no pageviews; any router integration is opt-in. This hook is that opt-in integration in its thinnest, router-agnostic form. Do NOT patch `history` or add a `popstate` listener.
- **Delegates to `useAnalytics()`** (S3) — the hook does not read context itself twice; it calls `useAnalytics<TX>().page(...)`. Taxonomy `TX` flows from that call, so `props` type-checks against the consumer's declared `page` props (the seam types `page(name?, props?: TX['page'])`).
- **Effect-keyed, SSR-safe** — `useEffect(() => { analytics.page(name, props) }, [routeKey])` fires on mount + on `routeKey` change. Effects don't run during SSR (same guarantee S2 relies on), so no server pageview / no DOM read. The consumer owns the route source (Next `usePathname`, pages-router `router.asPath`, React Router `useLocation`), keeping the hook framework-agnostic.
- **Expansion path** (epic): a future App-Router/Pages-Router convenience wrapper can wrap this hook, reading the router internally — additive, still delegating to `page()`. Out of R1.

## Shipped
