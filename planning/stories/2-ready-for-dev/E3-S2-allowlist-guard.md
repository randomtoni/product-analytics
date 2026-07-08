---
id: E3-S2-allowlist-guard
epic: E3-CORE-taxonomy-allowlist
status: ready-for-dev
area: core
touches: [privacy]
depends_on: [E3-S1-define-taxonomy-typed-facade]
api_impact: additive
---

# E3-S2-allowlist-guard — Payload allowlist guard at the facade call-boundary

## Why

The payload allowlist is the library's vendor-neutral privacy contract: only consumer-supplied keys leave the app, and a violation fails loudly. Enforcement lives at the facade call-boundary — before any enrichment or adapter sees the event — so the contract holds identically for every adapter (bar A) and no adapter can re-implement or skip it.

## Scope

### In

- Extend `AnalyticsConfig` additively: `allowlist?: string[]` and `onViolation?: 'throw' | 'drop-and-error-log'` (default `throw`). Adding these fields **breaks the `create-analytics.test.ts` `AnalyticsConfig` shape pin** (~line 149, `expectTypeOf<AnalyticsConfig>().toEqualTypeOf<{ key?: string }>()`, and its `AnalyticsConfig.key is the only field E2 needs` title/assertion) — rewrite that pin to the extended shape (expected churn; if S1 already added `taxonomy?`, extend that same rewrite rather than reverting it).
- Thread `allowlist` + `onViolation` from `createAnalytics(config)` into `AnalyticsProviderImpl` via the constructor. **The new constructor params MUST be optional/additive** — `new AnalyticsProviderImpl(adapter)` is constructed directly 19 times across the E2 tests and must keep compiling unchanged.
- The guard — synchronous, PRE-enrichment, at the call-boundary of `track` / `page` / `identify` / `group` / `setTraits`. It checks the **keys** of the consumer-supplied props/traits objects against the allowlist:
  - off-list key + `throw` (default) → throw a clear error naming the offending key;
  - off-list key + `drop-and-error-log` → drop the event (no adapter call) and surface the violation via the error/warn surface (see Technical notes for the exact sink); do not throw.
- **The gated object per verb** (each is a distinct consumer-supplied bag — miss none): `track(event, props)` → `props`; `page(name, props)` → `props`; `group(type, key, props)` → `props`; `setTraits(traits, once)` → `traits`; `identify(id, traits, traitsOnce)` → **BOTH `traits` AND `traitsOnce`** (both carry consumer-supplied keys). Identity arguments are NOT gated keys: the page `name`, the group `type`+`key`, and the distinct `id` are event/identity, not props.
- When no `allowlist` is configured (i.e. `config.allowlist === undefined`): the guard is **inactive** (all keys pass) — enforcement is opt-in, activated by supplying an allowlist. This preserves the E2 `createAnalytics({})` behavior. **Activation predicate is `allowlist !== undefined`, not `allowlist?.length > 0`** — an explicit `allowlist: []` IS a policy ("allow nothing"), so it activates the guard and every off-list (i.e. every) key throws. Deliberate per architect (2026-07-07): S3's `deriveAllowlistFromTaxonomy` can return `[]` for a keyless taxonomy, so this must be an explicit line, not incidental behavior.
- The guard lives in the non-generic `AnalyticsProviderImpl`, operating on erased runtime values (independent of the compile-time `T` from S1).

### Out

- `deriveAllowlistFromTaxonomy` convenience + the consumer-injected-enrichment (E6 country) forward-guard path — **S3**.
- Enrichment computation (page/UTM/device/country) — **E6**. Library-computed keys are added downstream inside the adapter and never reach the guard.
- Any adapter-level re-enforcement — the guard lives ONLY at the facade; adapters must not re-implement it.
- Moving or duplicating the guard's position — it stays at the facade call-boundary.

## Acceptance criteria

- [ ] With an allowlist configured, `track('e', { offListKey: 1 })` throws by default (error names the offending key); `track('e', { onListKey: 1 })` passes and reaches `adapter.capture`.
- [ ] `onViolation: 'drop-and-error-log'` → the offending event is dropped (zero adapter calls for it), the violation is surfaced via the log sink (assert by spying on `globalThis.console.error` — see Technical notes), and nothing throws.
- [ ] The guard runs PRE-enrichment and PRE-adapter: a rejected event never reaches `adapter.capture`/`identify`/`group` (assert against a mock/spy adapter — never a real backend).
- [ ] `page` / `group` / `setTraits` props/traits keys are gated identically to `track`; `identify` gates BOTH its `traits` and `traitsOnce` bags; identity args (page `name`, group `type`+`key`, distinct `id`) are not treated as gated keys.
- [ ] An explicit `allowlist: []` activates the guard (empty policy = allow nothing); `allowlist` undefined leaves it inactive.
- [ ] No allowlist configured ⇒ guard inactive; the E2 `createAnalytics({})` capture/identify behavior is unchanged (backward-compat).
- [ ] The guard is enforced only at the facade — no adapter re-enforces it, so swapping adapters changes nothing about the privacy contract (bar A).
- [ ] A loud violation is demonstrated as an executable assertion.
- [ ] `grep -ri posthog packages/analytics-kit/src` clean; `pnpm --filter analytics-kit typecheck`, `lint`, `test`, `build` exit 0.

## Technical notes

- **Guard position — the load-bearing decision (— architect 2026-07-07, epic Notes):** at the facade call-boundary, BEFORE the adapter and BEFORE enrichment, because it's a vendor-neutral privacy contract that must hold identically for every adapter; it cannot live where each adapter could re-implement or skip it. Fail loud — throw by default per the BRIEF's "fails loudly"; `drop-and-error-log` is the opt-in prod-resilience mode.
- **De-brand the CONTRAST, don't copy (epic Notes):** posthog-js's structurally-similar `before_send` runs AFTER enrichment as a soft mutate/drop hook (`packages/browser/src/posthog-core.ts:1453-1462`) — the **inverse** position and semantics. Our guard is pre-enrichment and rejecting, not post-enrichment and mutating. Use the contrast as a reference; do not port the shape.
- **`drop-and-error-log` sink — pinned (— architect 2026-07-07):** the seam has NO DOM lib and NO `@types/node`, so `console` is NOT ambiently typed, and `no-explicit-any` forbids `any`. Reach it via a typed `globalThis` cast + optional chaining (compiles clean under tsc + eslint here):
  ```ts
  type ConsoleLike = { error(...args: unknown[]): void };
  function emitViolation(message: string): void {
    (globalThis as { console?: ConsoleLike }).console?.error?.(message);
  }
  ```
  `globalThis` is typed by the ES2022 lib (no DOM needed); the structural cast uses `unknown[]` (not `any`); optional chaining tolerates runtimes without `console`. Use `.error` (the throw-analogue severity). Resolve the console once in one small internal helper rather than scattering the cast per verb. This is the de-branded shape of PostHog's own `ConsoleLike` logger facade (`posthog-js/packages/core/src/utils/logger.ts`), adapted for the seam's lib constraints. The `onViolation` UNION (`'throw' | 'drop-and-error-log'`) is the locked seam; this note only pins how the "log" side emits — it does not change the union.
- **`page` IS gated (— architect 2026-07-07, Q4):** `page(name?, props?)` carries consumer-supplied `props` — values leaving the app — and routes through the same `buildEvent → capture` path as `track`. The BRIEF's privacy contract runs on "every outgoing event"; a pageview is a captured event. `page`'s absence from the epic's original enumeration was an oversight, not an exemption (epic Success-criteria has since been amended to include it). The page `name` is event identity, not a gated prop key.
- **Keys computed vs supplied (epic Notes):** the guard gates the KEYS of consumer-supplied props/traits objects. Library-computed enrichment keys are added downstream (inside the adapter, after this guard) and are therefore implicitly allowed — they never reach the guard. S3 formalizes the "library computes ⇒ trusted; consumer supplies ⇒ gated" rule and the E6 injected-value exception.
- **No-allowlist ⇒ inactive (PM 2026-07-07):** enforcement is opt-in — supplying an `allowlist` activates it. Forced by backward-compat with the E2 `createAnalytics({})` tests (which `track('x')` with no allowlist and must keep passing) and consistent with "policy is the consumer's, enforcement is the library's" — no policy supplied, nothing to enforce.
- **Guard runs regardless of consent state (PM 2026-07-07):** run the guard at the top of each verb, before delegating to `this.adapter` (which may be the swapped-in no-op after `optOut`). A policy violation is a config/programming error and should surface loudly even while opted out. This keeps the guard orthogonal to the S5 opt-out routing (the reassignable-adapter field is untouched by this story).
- **Constructor threading:** `createAnalytics` passes the resolved `allowlist`/`onViolation` into `AnalyticsProviderImpl` (extend the E2 constructor additively). The guard reads them; it does not touch the taxonomy `T` (compile-time only).

## Shipped
