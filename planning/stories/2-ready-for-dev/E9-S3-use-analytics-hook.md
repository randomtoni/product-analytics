---
id: E9-S3-use-analytics-hook
epic: E9-RCT-react-binding
status: ready-for-dev
area: react
touches: [react]
depends_on: [E9-S2-analytics-client-provider]
api_impact: additive
---

# E9-S3-use-analytics-hook — `useAnalytics()` hook

## Why

The consumer-facing read path: a hook that returns the same neutral client the rest of the library exposes, so components call `useAnalytics().track(...)` / `.page(...)` instead of importing a global. Taxonomy typing flows through the hook so a consumer's declared events type-check at the call site.

## Scope

### In

- **`useAnalytics<TX>()`** — a one-line `useContext(AnalyticsClientContext)` read that returns the neutral client, typed **`RootAnalytics<TX>`** (the widened return of `createAnalytics()` — carries the full frozen facade PLUS `context()`; must NOT narrow away `context()`).
- **Loud/typed failure outside a provider**: when the hook is called with no provider above it (context holds no client / holds `undefined`), it throws a clear, typed error naming the missing `AnalyticsClientProvider` — not a silent `undefined` return that defers to a downstream `.track is not a function`. (Reference posture: posthog's default-context indirection returns a global; WE have no global, so a missing provider is a hard, explanatory throw.)
- **Taxonomy typing through the hook**: the return type carries `TX` so `useAnalytics<AppEvents>().track('signed_up', {...})` type-checks the consumer's declared events/props exactly as the direct `createAnalytics<T>()` return does. The hook is generic; the taxonomy shape flows from the type argument (the consumer's `ShapeOf<T>`), matching how the browser `createAnalytics` overload returns `RootAnalytics<ShapeOf<T>>`.
- Export `useAnalytics` (and the provider/context from S2) from `src/index.ts`.

### Out

- `usePageView()` / router integration — S4.
- Feature-flag / session-replay hooks (typed extension points only — epic Out of scope; they drop in additively later reading `client.flags?` / `client.replay?`).
- A scoped-context hook variant (e.g. `useAnalytics` returning `context(name)`) — NOT in R1; `useAnalytics()` returns the root, and a consumer calls `.context(name)` on it directly. (Flag as a possible additive future ergonomic; do not build.)

## Acceptance criteria

- [ ] `useAnalytics()` returns the exact client provided by `AnalyticsClientProvider` (same instance) — asserted with a known client in a `@testing-library/react` `renderHook`.
- [ ] The return type is **`RootAnalytics<TX>`** — pinned with `expectTypeOf<ReturnType<typeof useAnalytics>>().toEqualTypeOf<RootAnalytics<...>>()`, proving `context()` survives (not narrowed to the base `AnalyticsProvider`).
- [ ] Taxonomy flows: `useAnalytics<Shape>().track('declared_event', props)` type-checks against the consumer's declared taxonomy; an undeclared event / wrong prop shape is a compile error (a type-level test).
- [ ] Called outside any `AnalyticsClientProvider`, the hook throws a clear error naming the missing provider (a test asserts the throw + message mentions the provider by name).
- [ ] Bar A: a component using `useAnalytics()` needs ZERO change when the backend adapter is swapped (the hook returns the neutral facade, not a vendor client).
- [ ] Bar B: under an unkeyed provider, `useAnalytics()` returns the no-op-backed client and calls are silent (rides the S2 no-op).
- [ ] Frozen-15 held: the hook EXPOSES the facade — it adds no verb; `keyof` the returned client is unchanged.
- [ ] Zero vendor references in the hook name, signature, or error message.

## Technical notes

- **De-brands** `posthog-js/packages/react/src/hooks/usePostHog.ts` (`:4-7` — a one-line `useContext` read). Ours differs in one deliberate way: posthog's `usePostHog` returns a global default when no provider is present (their context default is a lazy global getter, `PostHogContext.ts:12-17`); WE have no global instance, so a missing provider is a **hard throw**, not a silent global. This is the neutral, footgun-free posture.
- **`useAnalytics` is the ONLY hook this release** — epic Notes (architect 2026-07-07): ship only `useAnalytics()`, the neutral analog of `usePostHog`; posthog's other hooks (`hooks/index.ts:1-6`) are all feature-flag/survey hooks and are out of scope (typed extension points only, E2).
- **Return type `RootAnalytics<TX>`** — architect (2026-07-08): the hook must return the wider type `createAnalytics()` actually hands back (carries `context()`), not the base `AnalyticsProvider` interface. Add an `expectTypeOf` pin so a future refactor can't silently narrow it. `RootAnalytics`/`AnalyticsProvider`/`ScopedAnalytics` are re-exported from `@analytics-kit/browser` (verified in its `index.ts`).
- **Taxonomy typing** — mirror the browser `createAnalytics<const T extends TaxonomyDecl>` overload: the hook takes a taxonomy-shape type param and returns `RootAnalytics<TX>`; the consumer supplies `ShapeOf<T>` (or the declared shape) as the type argument. `TaxonomyShape`/`DefaultTaxonomyShape`/`ShapeOf` come from the seam (re-exported). Default type param → `DefaultTaxonomyShape` (loose), so `useAnalytics()` with no arg still works.
- **Frozen-15 discipline** — the returned `RootAnalytics` already carries exactly the 15-pinned facade + `context()`; the hook must not wrap/add verbs. Pin: `analytics-kit`'s `analytics-provider.test.ts` freezes `keyof AnalyticsProvider` at 15.

## Shipped
