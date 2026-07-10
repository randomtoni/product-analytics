---
id: E12-S5-react-flag-hook
epic: E12-FF-flag-substrate-remote-eval
status: ready-for-dev
area: feature-flags
touches: [react]
depends_on: [E12-S1, E12-S2]
api_impact: additive
---

# E12-S5-react-flag-hook — React flag hook

## Why

React consumers need a hook that surfaces the flag set reactively — browser flags arrive async (first-load fetch), so the hook must re-render when `onChange` fires. Taxonomy-typed through `TX`, it mirrors `useAnalytics`'s in-provider sentinel guard. This completes the flag surface for the React binding.

## Scope

### In

- **React flag hook (`ts/packages/react/src/use-feature-flags.ts` or `use-flags.ts`, named by role)** — a hook, taxonomy-typed through `TX`, built on the S1 `onChange`:
  - Reads `client.flags` from the same context `useAnalytics` reads; subscribes via `onChange` in an effect and re-renders when the flag set arrives/changes; unsubscribes on unmount (the `() => void` S1 returns).
  - Returns the current `FlagSet<TX>` (or the typed reads off it — decide the exact ergonomics at refine: a `FlagSet` handle vs. per-key convenience reads; default to returning the `FlagSet` handle so `isEnabled`/`getFlag`/`getPayload`/`degraded`/`reason` are all reachable and the surface stays minimal).
  - Sentinel-throws outside a provider — mirrors `useAnalytics` (`throw new Error('useFeatureFlags() must be used within an <AnalyticsClientProvider>.')`), reusing the `NOT_IN_PROVIDER` sentinel from `analytics-client-context.ts`.
  - Handles the `flags` slot being absent (`client.flags === undefined` — an unkeyed/no-flag-adapter provider): return a stable, honest empty/degraded snapshot rather than throwing, so a consumer without a flag adapter still renders (bar B: config-only adoption; absence is not a crash).
- **Export from `ts/packages/react/src/index.ts`.**
- **Tests (`.test.tsx`, jsdom)** — re-render on `onChange` fire; unsubscribe on unmount; sentinel-throw outside provider; graceful behavior when `client.flags` is absent; taxonomy-typed reads narrow through `TX` (a type-test).

### Out

- **The flag adapters themselves** — S2 (browser, the one this hook exercises) / S3 / S4.
- **A `<FeatureFlagProvider>` / flag-gated render component** (`<PostHogFeature>` analog) — a convenience wrapper, deferred; the hook is the primitive. Declared-not-omitted.
- **Server-side / SSR flag hydration hooks** — the Python/node SSR bootstrap path is config (S1), not a React concern here.
- **`$feature_flag_called` exposure on read** — out of the epic; the hook reads trigger no capture.

## Acceptance criteria

- [ ] `useFeatureFlags<TX>()` reads `client.flags` from the provider context, subscribes via `onChange`, re-renders when the flag set arrives/changes, and unsubscribes on unmount (a test drives a mock `onChange` fire and asserts re-render + cleanup).
- [ ] Called outside `<AnalyticsClientProvider>` it throws the in-provider sentinel error (mirrors `useAnalytics`), reusing `NOT_IN_PROVIDER`.
- [ ] With `client.flags === undefined` (unkeyed / no flag adapter) the hook returns a stable honest empty/degraded snapshot and does NOT throw — the component renders (bar B).
- [ ] Taxonomy typing flows: `useFeatureFlags<TX>()` reads narrow per `TX['flags']` (a type-test), identical to the port's narrowing.
- [ ] Neutrality: `grep -ri posthog ts/packages/react/src` clean; `pnpm neutrality-scan` green.
- [ ] Gates green: `pnpm --filter @analytics-kit/react build test typecheck lint`.

## Technical notes

- reference: `posthog-js/packages/react` — `useFeatureFlagEnabled` / `useFeatureFlagPayload` / `useActiveFeatureFlags` hooks + the `PostHogFeature` component. De-brand: name by role, strip `posthog`; adopt the `onChange`-driven re-render pattern (PostHog's hooks subscribe to `onFeatureFlags`). We surface ONE hook returning the `FlagSet` handle rather than the per-concern hook fan-out — smaller, taxonomy-typed surface; per-key convenience can layer additively later. Consult `posthog-source-guide` for the exact re-render/subscription mechanics in the React binding before porting.
- **Mirror `useAnalytics` exactly** (`ts/packages/react/src/use-analytics.ts`): same context (`AnalyticsClientContext`), same `NOT_IN_PROVIDER` sentinel guard, same `<TX extends TaxonomyShape = DefaultTaxonomyShape>` generic default. The flag hook is the async-subscribing sibling of the synchronous `useAnalytics`.
- **`onChange`-driven, not `evaluate`-in-render:** subscribe in an effect and hold the current `FlagSet` in state; the browser adapter's re-firing `onChange` (S2) drives re-renders. Do NOT call `evaluate()` in the render body (async, would re-fetch per render). Trigger the initial `evaluate` once on mount (or rely on the adapter's init fetch) and let `onChange` deliver the result.
- **Absent-slot honesty:** `client.flags` is optional on the provider (S1). The hook must handle `undefined` gracefully (empty/degraded snapshot), because a consumer can adopt analytics-kit without a flag adapter — crashing would violate bar B.

## Shipped

<!-- Empty at draft. /implement-epics fills this once, when the story moves to stories/5-done/. Do not hand-edit. -->
