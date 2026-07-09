---
id: E9-S2-analytics-client-provider
epic: E9-RCT-react-binding
status: ready-for-dev
area: react
touches: [react]
depends_on: [E9-S1-react-package-scaffold]
api_impact: additive
---

# E9-S2-analytics-client-provider — SSR-safe `AnalyticsClientProvider` + context

## Why

The core of the binding: a React context provider that places the neutral client in context so a consumer wraps their tree once instead of hand-threading the client through every component. It must be SSR-safe (Next.js) and StrictMode-safe, and it must construct the client via the inward `@analytics-kit/browser` path when given a `config`.

## Scope

### In

- **`AnalyticsClientContext`** — a React `createContext` holding `{ client: RootAnalytics<TX> | undefined }` (or the resolved client). Internal module (`src/context.ts` or `src/analytics-client-context.ts`); the context object may be exported for advanced use but the hook (S3) is the intended read path.
- **`AnalyticsClientProvider`** component (named by role — see naming note) accepting **discriminated-union props**, mutually exclusive:
  - `{ client: RootAnalytics<TX>; config?: never }` — use the caller's pre-built client as-is.
  - `{ config: AnalyticsConfig & { taxonomy? }; client?: never }` — construct a browser client internally via `@analytics-kit/browser`'s `createAnalytics(config)`.
  - Plus `children`.
- **Client-wins-with-warning** when both are somehow passed (defeating the type via `any`): the `client` prop wins; emit a dev-mode `console.warn` (guarded so it's silent in production — gate on `process.env.NODE_ENV !== 'production'`).
- **SSR-safe init**: construction of the browser client happens **in `useEffect`, never during render / `useMemo`** — the server render must never initialize a client (no DOM access at render time, no `createAnalytics` call on the server). Hold the client in a ref/state; provide it via context once constructed. On the server render, context yields `undefined` (or a stable placeholder) and no client is built.
- **StrictMode double-invoke guard**: React 18 StrictMode double-invokes effects in dev; a guard (a ref tracking prior construction, keyed on `config`/`client` identity) prevents building two clients / double-init. When only `client` is passed, no construction happens — the guard is a no-op.
- **No auto-pageview**: the provider wires context ONLY. It captures NO pageviews and installs NO history listener (BRIEF §1; epic Notes architect 2026-07-07). `page()` stays manual/router-driven — the optional router hook is S4.
- **Whole-stack no-op flows through**: when `config` is unkeyed, `createAnalytics` already returns the no-op-backed client (browser `resolveAdapter` → `NoopAdapter`); the provider builds and provides it identically. The provider itself adds no keyed/unkeyed branching — the no-op posture rides the client (bar B).

### Out

- `useAnalytics()` hook — S3 (this story ships the context + provider; a temporary `useContext` in the smoke test is fine but the exported hook lands in S3).
- `usePageView()` / any router integration — S4.
- Feature-flag / session-replay React helpers (typed extension points only this release — epic Out of scope).
- Reacting to `config` changes after mount beyond the StrictMode guard (posthog-js re-runs `set_config` on options change; NOT in scope — a changed `config`/`client` prop after mount is a consumer footgun; document that the client is constructed once, mirror is deferred to the expansion path).

## Acceptance criteria

- [ ] `<AnalyticsClientProvider config={...}>{children}</AnalyticsClientProvider>` renders children and, after mount (effect), provides a constructed `RootAnalytics` via context.
- [ ] `<AnalyticsClientProvider client={existing}>` provides the caller's client without constructing a new one.
- [ ] **SSR-safe**: rendering the provider to string (server, no DOM / `renderToString`-style, or a test asserting no `createAnalytics` call during render) initializes NO client — construction is effect-only. No DOM/`window` access at module or render time throws under SSR.
- [ ] **StrictMode double-invoke** does not double-construct / double-init the client (a test wrapping the provider in `<React.StrictMode>` asserts one construction).
- [ ] Passing both `client` and `config` (via cast) makes `client` win and emits exactly one dev-mode warning; the warning is suppressed when `NODE_ENV === 'production'`.
- [ ] The provider auto-captures no pageviews (no `page()` call and no history listener installed by mounting the provider) — asserted with a recording/mock client.
- [ ] Unkeyed `config` → the provider still renders and provides the no-op-backed client (bar B); `track`/`page` through it are silent no-ops.
- [ ] Zero vendor references; the provider calls only `@analytics-kit/browser`'s public `createAnalytics` — never an adapter internal (bar A seam intact).
- [ ] Frozen-15 held: the provider exposes the client's existing facade + `context()`; it adds NO new facade verb.

## Technical notes

- **Naming — resolved (architect 2026-07-08):** the React context component is **`AnalyticsClientProvider`** (named by role — "provides the analytics client to the tree"), the context is **`AnalyticsClientContext`**. This deliberately does NOT reuse the seam's pinned TS interface name `AnalyticsProvider` (which is the 15-member client *contract*, unrenameable). Rationale: posthog-js can call theirs `PostHogProvider` because their interface is `PostHog`, not `PostHogProvider` — copying that pattern here would collide with our `AnalyticsProvider` interface. `...Provider` keeps the React ecosystem affordance; `Client` disambiguates from the interface. De-brands `posthog-js/packages/react/src/context/PostHogProvider.tsx` + `PostHogContext.ts` (shape reference only; posthog-specific bits — `getDefaultPostHogInstance`, `window.posthog` fallback, `bootstrap` — are dropped).
- **Discriminated-union props** — epic Notes (architect 2026-07-07): existing `client` XOR `config`, mutually exclusive; client wins when both passed, with a dev-mode warning. Reference shape: `PostHogProvider.tsx:23-25` (the union) and `:52-60` (the both-passed warnings). Our discriminant is `client` vs `config` (posthog's is `client` vs `apiKey`).
- **Effect-only init, SSR-safe** — epic Notes (architect 2026-07-07): init runs in `useEffect`, NOT during render/`useMemo` (`PostHogProvider.tsx:81-136` + the `:83-100` init split; the `:81` comment explains why effect not memo — SSR + hydration + double-init). Ours differs: posthog inits a pre-created global default instance; WE construct the client via `createAnalytics(config)` in the effect (no global default instance concept). Hold it in `useState`/`useRef`; provide via context once built.
- **StrictMode guard** — a `useRef<PreviousInitialization | null>` keyed on the resolved `config`/`client` identity (`PostHogProvider.tsx:47,:91-107,:130-133` is the pattern; simplify — we don't support live apiKey/options mutation, so the guard is just "already constructed for this input → skip"). Prefer keying construction on a stable `config` reference; document that a consumer should memoize `config` (posthog's `JSON.stringify(options)` dep trick, `:79`, is the reference; a stable-ref requirement is cleaner than deep-compare for R1).
- **Inward construction** — the `config` branch calls `@analytics-kit/browser`'s `createAnalytics` (public factory) — the browser target is the peer dep (S1). Dependencies point inward: `react → browser → seam` (epic Notes architect §E1). Never import a target adapter into the react package or the seam.
- **`AnalyticsConfig` / `RootAnalytics` types** come from `@analytics-kit/browser` (which re-exports them from the seam). Type the `config` prop as `AnalyticsConfig` (optionally taxonomy-generic — but full taxonomy-through-props generics can stay in S3 where the hook return type carries `TX`; keep S2 typed to the default shape unless the generic is trivial to thread).
- **No auto-pageview** — `PostHogProvider.tsx:140` (the return wires context and does NOT capture) is the reference; ours holds the same posture (BRIEF §1).
- Do NOT expose `AnalyticsProviderImpl` or reach into the client's internals — the provider is a pure consumer of the public `RootAnalytics` facade.

## Shipped
