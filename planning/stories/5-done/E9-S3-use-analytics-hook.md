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

- **`useAnalytics<TX extends TaxonomyShape = DefaultTaxonomyShape>(): RootAnalytics<TX>`** — a one-line `useContext(AnalyticsClientContext)` read that returns the neutral client, typed **`RootAnalytics<TX>`** (a CLEAN, non-nullable return — the widened `createAnalytics()` type carrying the full frozen facade PLUS `context()`; must NOT narrow away `context()` and must NOT be `RootAnalytics<TX> | undefined`). Because S2 constructs synchronously (client in context from render 1), there is no not-ready window and the return is always a real client. **The type param is a derived `TaxonomyShape`, NOT a `TaxonomyDecl`** (see Technical notes — this is the crux the builder must get right).
- **Loud/typed failure outside a provider**: the hook throws ONLY when the context still holds the **not-in-provider sentinel** S2 sets as the `createContext` default (no `AnalyticsClientProvider` anywhere above → clear, typed error naming the missing provider). Inside any provider the context always holds a real client (S2's synchronous construction — no `undefined`/not-ready state to handle), so the only failure mode is "no provider at all". Distinguish trivially: if `useContext(...) === NOT_IN_PROVIDER_SENTINEL` → throw; otherwise return the client. (Reference posture: posthog's default-context indirection returns a global; WE have no global, so *no provider at all* is a hard, explanatory throw.)
- **Taxonomy typing through the hook**: the return type carries `TX` so `useAnalytics<AppEventsShape>().track('signed_up', {...})` type-checks the consumer's declared events/props exactly as a direct `createAnalytics(...)` return does. The hook is generic on a **`TaxonomyShape`** (the already-derived form). The consumer supplies the shape explicitly — `useAnalytics<ShapeOf<typeof myDecl.decl>>()` or `useAnalytics<AppEventsShape>()` — because the hook, reading from context with no runtime `taxonomy` value, has nothing to infer from (unlike `createAnalytics`, which infers `T` from the `taxonomy` value in `config`). Bare `useAnalytics()` degrades to the open `DefaultTaxonomyShape`.
- Export `useAnalytics` from `src/index.ts` (S2 already exports `AnalyticsClientProvider` + context; this story ADDS the hook export, does not re-own the provider export).

### Out

- `usePageView()` / router integration — S4.
- Feature-flag / session-replay hooks (typed extension points only — epic Out of scope; they drop in additively later reading `client.flags?` / `client.replay?`).
- A scoped-context hook variant (e.g. `useAnalytics` returning `context(name)`) — NOT in R1; `useAnalytics()` returns the root, and a consumer calls `.context(name)` on it directly. (Flag as a possible additive future ergonomic; do not build.)

## Acceptance criteria

- [ ] `useAnalytics()` returns the exact client provided by `AnalyticsClientProvider` (same instance) — asserted with a known client in a `@testing-library/react` `renderHook`.
- [ ] The return type is the clean, non-nullable widened **`RootAnalytics<TX>`** (proving `context()` survives, not narrowed to the base `AnalyticsProvider`, and NOT `| undefined`) — pinned with `expectTypeOf<ReturnType<typeof useAnalytics>>().toEqualTypeOf<RootAnalytics<...>>()`. The builder must NOT silently narrow `context()` away and must NOT type the hook as the bare base `AnalyticsProvider`.
- [ ] Taxonomy flows: `useAnalytics<AppEventsShape>().track('declared_event', props)` type-checks against the consumer's declared taxonomy; an undeclared event / wrong prop shape is a compile error (a type-level test). `AppEventsShape` is a `TaxonomyShape` (e.g. `ShapeOf<typeof myDecl.decl>`), supplied explicitly.
- [ ] Called outside any `AnalyticsClientProvider` (context still at its sentinel default), the hook throws a clear error naming the missing provider (a test asserts the throw + message mentions the provider by name). Inside a provider the hook always returns a real client (no not-ready state) — a test under a config-branch provider asserts the returned client is a real `RootAnalytics` from render 1.
- [ ] Bar A: a component using `useAnalytics()` needs ZERO change when the backend adapter is swapped (the hook returns the neutral facade, not a vendor client).
- [ ] Bar B: under an unkeyed provider, `useAnalytics()` returns the no-op-backed client and calls are silent (rides the S2 no-op).
- [ ] Frozen-15 held: the hook EXPOSES the facade — it adds no verb; `keyof` the returned client is unchanged.
- [ ] Zero vendor references in the hook name, signature, or error message.

## Technical notes

- **De-brands** `posthog-js/packages/react/src/hooks/usePostHog.ts` (`:4-7` — a one-line `useContext` read). Ours differs in one deliberate way: posthog's `usePostHog` returns a global default when no provider is present (their context default is a lazy global getter, `PostHogContext.ts:12-17`); WE have no global instance, so a missing provider is a **hard throw**, not a silent global. This is the neutral, footgun-free posture.
- **`useAnalytics` is the ONLY hook this release** — epic Notes (architect 2026-07-07): ship only `useAnalytics()`, the neutral analog of `usePostHog`; posthog's other hooks (`hooks/index.ts:1-6`) are all feature-flag/survey hooks and are out of scope (typed extension points only, E2).
- **Return type `RootAnalytics<TX>`** — architect (2026-07-08): the hook must return the wider type `createAnalytics()` actually hands back (carries `context()`), not the base `AnalyticsProvider` interface. Add an `expectTypeOf` pin so a future refactor can't silently narrow it. `RootAnalytics`/`AnalyticsProvider`/`ScopedAnalytics` ARE re-exported from `@analytics-kit/browser` (verified in its `index.ts`) — but the **taxonomy types are NOT** (see next note); import `RootAnalytics` from wherever you take the taxonomy types to keep one import source, i.e. from `analytics-kit` (the seam), which exports all of them.
- **Taxonomy typing — the param is a `TaxonomyShape`, NOT a `TaxonomyDecl`** (architect 2026-07-08, correcting the earlier draft): `useAnalytics<TX extends TaxonomyShape = DefaultTaxonomyShape>(): RootAnalytics<TX>`. It mirrors **`RootAnalytics`'s own param** (`analytics-provider.ts:82` — `RootAnalytics<TX extends TaxonomyShape>`), NOT `createAnalytics`'s `<const T extends TaxonomyDecl>` inference param (`create-analytics.ts` overload). The `<const T extends TaxonomyDecl>` machinery exists ONLY to *infer* `T` from the runtime `taxonomy: Taxonomy<T>` value in `config` and then map it via `ShapeOf<T>`; the hook has NO config/no runtime taxonomy value to infer from (it reads the client out of context), so the caller supplies the already-derived shape explicitly: `useAnalytics<ShapeOf<typeof decl.decl>>()` or a shape alias. Bare `useAnalytics()` degrades to the open `DefaultTaxonomyShape` — there is NO zero-arg typed path the way `createAnalytics` gets one for free (do not try to recover inference that isn't recoverable from context).
- **Where the taxonomy types come from (import source).** `TaxonomyShape` / `DefaultTaxonomyShape` / `ShapeOf` are exported from **`analytics-kit`** (the seam) and are **NOT re-exported from `@analytics-kit/browser`** (verified `packages/browser/src/index.ts` re-exports only `AnalyticsProvider`/`RootAnalytics`/`ScopedAnalytics`/`AnalyticsConfig`/`CaptureProfile`). So the hook's signature imports `TaxonomyShape`/`DefaultTaxonomyShape` (and, for consistency, `RootAnalytics`) from `analytics-kit` directly — react already depends on the seam (S1's two-deps note). Consumers typing the hook do the same: import `ShapeOf`/`TaxonomyShape` from `analytics-kit`.
- **Return type is clean `RootAnalytics<TX>` — no `| undefined`** (orchestrator 2026-07-08, resolving the earlier init-window tension): S2 now constructs the config-branch client **synchronously** (`useState` lazy init — client in context from render 1), so there is NO not-ready window and the hook never returns `undefined`. The only non-client state is the not-in-provider sentinel, which is a throw, not a return value. Do not reintroduce a nullable return or a "mid-init" branch — they described the superseded effect-only posture.
- **Frozen-15 discipline** — the returned `RootAnalytics` already carries exactly the 15-pinned facade + `context()`; the hook must not wrap/add verbs. Pin: `analytics-kit`'s `analytics-provider.test.ts` freezes `keyof AnalyticsProvider` at 15.

## Shipped
- > Reviewer suggestion (2026-07-08): the runtime `keyof` keyset test rides on `createRecordingClient()` enumerating exactly the 15+`context` keys — a test-double fidelity dependency; the type-level `keyof ReturnType === keyof RootAnalytics` pin is the load-bearing guarantee. A one-line note would help a future reader.
- > Reviewer suggestion (2026-07-08, cosmetic): the no-provider error message duplicates the idea across two sentences — a single sentence would read marginally cleaner.

## Shipped

> Captured by `implement-epics` on 2026-07-08. The consumer-facing read path.

- **Files added (react):** `use-analytics.ts` (`useAnalytics<TX extends TaxonomyShape = DefaultTaxonomyShape>(): RootAnalytics<TX>` — one-line `useContext(AnalyticsClientContext)` read; hard-throws naming `AnalyticsClientProvider` ONLY on the `NOT_IN_PROVIDER` sentinel; single `as RootAnalytics<TX>` cast after the sentinel branch) + test
- **Files changed:** `index.ts` (+`useAnalytics` export; S2's provider/context exports untouched)
- **New public API:** `@analytics-kit/react` `useAnalytics<TX>()`. Bar A: returns the NEUTRAL facade (not a vendor client) — zero React-code change on adapter swap. Frozen-15: adds NO verb. Zero vendor refs.
- **The two cruxes (reviewer-verified non-vacuous):** (1) clean non-nullable `RootAnalytics<TX>` return — `context()` SURVIVES, NOT the base `AnalyticsProvider`, NOT `| undefined` (`expectTypeOf` pins proven real by flipping to `AnalyticsProvider`→TS2344). (2) taxonomy-through-hook param is a `TaxonomyShape` (mirrors `RootAnalytics`'s own param), NOT `createAnalytics`'s `<const T extends TaxonomyDecl>` inference — consumer supplies the derived shape (`useAnalytics<ShapeOf<typeof decl.decl>>()`); bare→`DefaultTaxonomyShape`. Both `@ts-expect-error` (undeclared event + wrong prop) proven to fire.
- **De-brand:** posthog's `usePostHog` returns a silent global on no-provider; ours HARD-THROWS (neutral seam has no global — footgun-free). Taxonomy types imported from `analytics-kit` (seam, not re-exported by browser).
- **Tests added:** react +10 (same-instance renderHook, inside-real-client-render-1, outside-throws-naming-provider + plain-Error, bar-A neutral-facade, bar-B unkeyed-no-op-silent, frozen-15 runtime keyset + type-level `keyof`, clean-`RootAnalytics<TX>` expectTypeOf + `context()`-survives, taxonomy-flows + `@ts-expect-error` isolated in never-invoked fn) → 27; all 4 gates exit 0 (typecheck explicit)
- **Commit:** `E9-S3-use-analytics-hook — useAnalytics() hook` on `core-cycle`
- **Reviewer notes:** ship — 0 critical, 2 minor suggestions (keyset test-double fidelity; error-message cosmetic)
- **Cross-story seams exposed (S4):** `usePageView()` builds on `useAnalytics()` to get the client + fire manual `page()` on a consumer-threaded route change (no history listener). The no-provider throw is CENTRALIZED in `useAnalytics()` — S4 inherits the loud failure free, need not re-check the sentinel. S4 calls `useAnalytics()` bare (`DefaultTaxonomyShape`) unless it threads `TX` for the taxonomy-typed `page(name?, props?)`.
