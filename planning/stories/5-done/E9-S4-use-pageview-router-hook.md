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
- Signature shape (builder settles exact form): `usePageView<TX extends TaxonomyShape = DefaultTaxonomyShape>(routeKey: string | undefined, options?: { name?: string; props?: TX['page']; captureOnMount?: boolean })` — fires `page(options?.name, options?.props)` whenever `routeKey` changes (and on mount unless `captureOnMount === false`). The generic mirrors S3's `useAnalytics<TX>()` param — a **`TaxonomyShape`, NOT a `TaxonomyDecl`** (same rationale: no runtime taxonomy to infer from); `props` types against `TX['page']` (the seam signs `page(name?, props?: TX['page'])`). `TaxonomyShape`/`DefaultTaxonomyShape` import from `analytics-kit` (S1 two-deps note; browser does not re-export them).
- **Clean mount fire — no init-window handling needed.** Because S2 constructs the client **synchronously** (in context from render 1), `useAnalytics()` inside this hook always returns a real client (or throws if there's no provider) — there is NO `undefined`/not-ready window. So the hook's `useEffect` calls `analytics.page(...)` directly and fires the mount pageview cleanly on first mount, with the effect keyed on `[routeKey]` (mount + on `routeKey` change). No `if (!analytics) return;` readiness guard and no `analytics`-in-deps re-fire trick are required (the earlier draft's guard existed only for the superseded effect-only-construction window). A test covers: mount under a config-branch provider → the mount `page()` fires exactly once (and once per subsequent `routeKey` change).
- Export `usePageView` from `src/index.ts`.

### Out

- **Any App-Router / Pages-Router adapter layer** — no framework-specific wrapper that reads Next's router internally. That stays deferred (epic Expansion path: "a richer router integration extends this additively, still delegating to manual `page()`"). R1 ships ONE router-agnostic hook.
- **Auto-pageview inside the provider** — the provider (S2) captures nothing; this hook is separate and opt-in.
- **A `usePageLeave` hook** — pageleave is adapter-internal (E6, driven by the browser client's own unload handling), not a React hook this release. (posthog-js has no react `usePageLeave` either; do not invent one.)
- Reading `window.location` directly inside the hook as the route source — the consumer threads the route in from their router (SSR-safe; no DOM read at render).

## Acceptance criteria

- [ ] Calling `usePageView(path)` fires exactly one `page()` on mount and one on each `path` change — asserted with a recording/mock client via `renderHook` + rerender. Holds identically under both a `client`-branch and a `config`-branch provider (S2 synchronous construction means the client is ready at render 1 in both cases; no init-window special-casing).
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
- **Delegates to `useAnalytics()`** (S3) — the hook does not read context itself; it calls `useAnalytics<TX>().page(...)`, threading its OWN `TX` type param through to the hook (neither hook infers `TX` — both take an explicit `TaxonomyShape`; see S3). So `props` type-checks against the consumer's declared `page` props (the seam types `page(name?, props?: TX['page'])`). The consumer supplies `TX` once at the `usePageView<AppEventsShape>(...)` call site.
- **Effect-keyed, SSR-safe** — `useEffect(() => { analytics.page(name, props); }, [routeKey])` fires on mount + on `routeKey` change. `analytics` from `useAnalytics()` is a stable, always-real client (S2 synchronous construction — no not-ready window), so no readiness guard and no `analytics`-in-deps re-fire are needed (`[routeKey]` deps suffice; `[routeKey, analytics]` would be a harmless no-op since `analytics` is stable). Effects don't run during SSR, so no server pageview / no DOM read. The consumer owns the route source (Next `usePathname`, pages-router `router.asPath`, React Router `useLocation`), keeping the hook framework-agnostic.
- **Expansion path** (epic): a future App-Router/Pages-Router convenience wrapper can wrap this hook, reading the router internally — additive, still delegating to `page()`. Out of R1.

## Shipped
- > Reviewer note (2026-07-08): `captureOnMount` is read inside the effect but not in deps — intentional + correct (it's a mount-time decision, only consulted on the first run); a runtime toggle wouldn't memoize. Non-issue.
- > Reviewer suggestion (2026-07-08, optional): a one-line JSDoc pointing consumers at the route sources (`usePathname()`/`router.asPath`/`useLocation().pathname`) — the router-agnostic contract lives only in the story, not the code. E10's example will make the pattern visible.

## Shipped

> Captured by `implement-epics` on 2026-07-08. Closes E9 — the optional router pageview helper.

- **Files added (react):** `use-page-view.ts` (`usePageView<TX extends TaxonomyShape = DefaultTaxonomyShape>(routeKey: string | undefined, options?: {name?; props?: TX['page']; captureOnMount?})` — delegates to `useAnalytics<TX>()`, fires `page(name, props)` in `useEffect(..., [routeKey])`; `mounted` ref makes `captureOnMount:false` skip ONLY the first run; NO history listener, NO `window.location`) + test
- **Files changed:** `index.ts` (+`usePageView` + `UsePageViewOptions` export; S1–S3 exports untouched)
- **New public API:** `@analytics-kit/react` `usePageView<TX>()` + `UsePageViewOptions`. NET-NEW neutral (posthog-js react has no pageview hook — its SPA pageview is browser-SDK history-patching, deliberately NOT replicated). Bar A: calls only neutral `page()`, zero component change on adapter swap. Frozen-15: no verb. Zero vendor refs.
- **The crux (no auto-history):** installs NO global `history`/`popstate`/`pushState` listener, reads NO `window.location` — fires PURELY from the consumer-threaded `routeKey` (Next `usePathname()`/pages `router.asPath`/React Router `useLocation().pathname`). Proven: raw `pushState`×2 + dispatched `popstate` with unchanged `routeKey` → NO additional `page()`.
- **Effect correctness:** 1 on mount + 1 per `routeKey` change, unchanged→no-refire, `undefined→value`→refire — proven under BOTH client-branch AND real config-branch providers (S2 synchronous → real client render 1, no init-window guard, `[routeKey]` deps only, no `analytics`-in-deps).
- **Tests added:** react +15 (mount-once + change-refire + unchanged-no-refire ×both branches, no-history-listener, captureOnMount:false-suppresses-initial + default-fires, name/props-verbatim, undefined→value, bar-A only-page()-touched, SSR-safe no-fire-from-import, taxonomy `@ts-expect-error` wrong-type + undeclared-prop reviewer-verified-firing) → 42; all 4 gates exit 0 (typecheck explicit)
- **Commit:** `E9-S4-use-pageview-router-hook — optional usePageView() router helper` on `core-cycle`
- **Reviewer notes:** ship — 0 critical, 2 optional (captureOnMount memoization non-issue; route-source JSDoc)
- **E10 note:** demonstrate the consumer threading `usePathname()` (Next app router) into `usePageView` — the documented-but-uncommented route-source contract; use provider config-branch for zero-boilerplate adoption + client-branch for DI/tests. No library change for E10 (new-app-adoption bar).
