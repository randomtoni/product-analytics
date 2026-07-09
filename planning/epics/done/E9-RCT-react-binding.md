---
id: E9-RCT-react-binding
status: done
area: react
touches: [browser]
api_impact: additive
blocked_by: [E6-CAP-capture-enrichment]
updated: 2026-07-08
---

# E9-RCT-react-binding — React / Next binding

## Why

Optional `@analytics-kit/react` binding so React/Next consumers get the client from context and a hook instead of hand-threading it through the tree. It is the tail of the {identify → capture → react} lane — it wraps the capture/`page()` semantics E6 lands — and the generic example consumer (E10, bar B) wires its framework integration through this package. Adapted and de-branded from posthog-js `packages/react`, which is a shape reference only. Informed by `research/ARCHITECT-RELEASE1.md` §E9.

## Success criteria

- `@analytics-kit/react` ships an **SSR-safe** `AnalyticsProvider` component that places a neutral client in context: server render never initializes a client, and StrictMode's double-invoke does not double-init.
- Props are a **discriminated union** — an existing `client` XOR a `config` to construct one — mutually exclusive; passing both is deterministic (client wins, with a dev-mode warning).
- `useAnalytics()` returns the same neutral client the rest of the library exposes. A consumer swaps the backend adapter with zero React-code change (bar A) and adopts in a new app via config only (bar B).
- Zero vendor references in the package name, component/hook names, types, file names, and docs; the binding calls only the public API and never reaches into adapter internals (framework-agnostic seam intact).
- `page()` stays manual/router-driven — the provider auto-captures no pageviews; any router integration is opt-in.

## Stories

All four shipped to `stories/5-done/`. Built topo order: **S1 → S2 → S3 → S4** (a strict line). **Named by role** — the React component is `AnalyticsClientProvider` (the seam's pinned `AnalyticsProvider` interface name is unrenameable, so the component disambiguates with `Client`). Frozen-15 held — the binding EXPOSES the facade, adds no verb.

**Construction posture — lock relaxed (orchestrator 2026-07-08):** the epic's original "effect-only init (never render/useMemo)" lock existed to keep DOM access out of render for SSR. A fresh architect consult verified `createAnalytics(config)` is **DOM-free at construction** (every DOM access is `typeof`-guarded, E6), so that rationale was void. The provider therefore constructs **synchronously via a `useState` lazy initializer** (`useState(() => createAnalytics(config))`) — client in context from render 1, SSR-safe, matching posthog-js's synchronous `useMemo` posture — giving `useAnalytics()` a **clean non-nullable `RootAnalytics<TX>`** return (no init-window `| undefined`). Success-criteria line above (S2 "server render never initializes a client") is superseded: server render DOES construct (DOM-free), which is what makes the clean contract work.

- **[E9-S1](../stories/5-done/E9-S1-react-package-scaffold.md)** *(done — `1d12b24`)* — `@analytics-kit/react` scaffold: `react` + `@analytics-kit/browser` **peer deps** (browser = inward runtime construction; single shared client), seam `analytics-kit` REGULAR dep (taxonomy types not re-exported by browser — the two-deps-two-reasons split), `jsx:react-jsx` + `DOM` lib, jsdom + `@testing-library/react` harness. React 19.
- **[E9-S2](../stories/5-done/E9-S2-analytics-client-provider.md)** *(done — `2d3cc13`)* — SSR-safe **`AnalyticsClientProvider`** + sentinel-defaulted `AnalyticsClientContext`: discriminated-union props (`client` XOR `config`), **SYNCHRONOUS create-once** (`useState` lazy init), config-branch-owns→unmount-`shutdown()`, client-wins+dev-warn, no auto-pageview, unkeyed no-op rides through. (StrictMode: React 19 double-invokes the pure lazy init — tests assert the COMMITTED-client-stable invariant, not raw call-count.)
- **[E9-S3](../stories/5-done/E9-S3-use-analytics-hook.md)** *(done — `4956fd5`)* — **`useAnalytics<TX extends TaxonomyShape>(): RootAnalytics<TX>`** (clean non-nullable, `context()` preserved, taxonomy through the return — param is a `TaxonomyShape` not a `TaxonomyDecl`), hard-throws naming the provider on the no-provider sentinel.
- **[E9-S4](../stories/5-done/E9-S4-use-pageview-router-hook.md)** *(done — `d25df53`)* — optional router-agnostic **`usePageView<TX>()`**: fires manual `page()` in a `useEffect` keyed on the consumer-threaded route (Next app/pages, React Router), `captureOnMount?`, opt-in, NO history listener; net-new neutral (posthog-js react has no pageview hook). Framework router adapter deferred (## Expansion path).

## Out of scope

- **Feature-flag hooks** (`useFeatureFlag` / active-flags / payload hooks). Flags are a typed extension point only this release (the `FeatureFlagPort` declared in E2), not implemented — these belong to a future `feature-flags` cycle. See ## Expansion path.
- **Automatic pageview capture inside the provider.** `page()` remains manual/router-driven (BRIEF §1; architect §E9).
- **Session-replay React helpers** — session-replay is out this release (typed `SessionReplayPort` only).
- Any vendor-specific React helper or hook.

## Notes

- **Naming collision — decision for story-time, not epic-time.** The core TS **facade interface** is named `AnalyticsProvider` (BRIEF §1 / architect §E2), and the idiomatic React **context component** is also `AnalyticsProvider`. Same name, two different things (a TS interface in `analytics-kit` vs a React component in `@analytics-kit/react`). Do NOT silently pick here — surface options at story drafting: e.g. name the component by its role (a React `AnalyticsProvider` component wrapping the `AnalyticsProvider` facade type), or rename one side.
- — architect (2026-07-07): provider props are a discriminated union (existing `client` XOR `config`); client wins when both are passed (posthog-js `PostHogProvider.tsx:23-25,:52-60` is the shape reference only).
- — architect (2026-07-07): init runs in `useEffect` (SSR-safe, not during render/useMemo) with a StrictMode double-invoke guard (`PostHogProvider.tsx:81-136,:47`); the provider wires context only and does NOT auto-capture pageviews (`:140`).
- — architect (2026-07-07): ship only `useAnalytics()` — the neutral analog of `usePostHog` (`hooks/usePostHog.ts:4-7`, a one-line `useContext` read); PostHog's other hooks are feature-flag hooks (`hooks/index.ts:1-6`) and are out of scope.
- The binding exposes the neutral `AnalyticsProvider` client, never a vendor client; react is a consumer of the public API and must not reach into adapter internals.
- **`config`-path construction is inward, via the browser target.** The `config` branch of the discriminated union builds a browser client through `@analytics-kit/browser`'s public factory — not by importing a target adapter into the seam (architect §E1: dependencies point inward, browser/node/react → seam). So `@analytics-kit/browser` is a **peer dependency** here (single shared client instance, consumer-controlled version), mirroring posthog-js react's `posthog-js` peerDep (`posthog-js/packages/react/package.json:36-40`; construction/init split in `PostHogProvider.tsx:49,:83-100`). Public-API-only holds either way; how E2's seam-side `createAnalytics` reconciles adapter selection with the inward-only rule is E2's call — E9 only relies on the browser target being the construction path.

## Expansion path

- Feature-flag hooks (`useFeatureFlag`, payload hooks) drop in **additively** once a `feature-flags` cycle implements the `FeatureFlagPort` (E2 typed extension point): the provider already holds the client, so hooks read `client.flags?` with no breaking change.
- Session-replay React helpers attach the same way via the `SessionReplayPort`.
- A richer router integration (App-Router / Pages-Router adapters) extends the optional pageview helper additively, still delegating to manual `page()`.
