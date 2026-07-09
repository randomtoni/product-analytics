---
id: E10-S5-allowlist-loud-failure
epic: E10-CORE-example-consumer
status: ready-for-dev
area: core
touches: [example, privacy]
depends_on: [E10-S1-fernly-scaffold-recording-adapter, E10-S2-fernly-taxonomy-identity-mapping]
api_impact: additive
---

# E10-S5-allowlist-loud-failure — Allowlist contents + the deliberate off-list-key loud-failure assertion

## Why

Exercises E3's privacy contract as an executable proof: the consumer supplies the allowlist of prop/trait keys permitted to leave the app, and a deliberate off-list key (e.g. a raw-PII field) fails LOUDLY (throw by default). Privacy POLICY is the consumer's; ENFORCEMENT is the library's — this story demonstrates both, config-only.

## Scope

### In

- An explicit `allowlist` in the harness config enumerating the permitted prop/trait keys for Fernly's taxonomy (config-only). Optionally demonstrate `deriveAllowlistFromTaxonomy` as the derive-from-declared-shape path.
- A **deliberate off-list-key loud-failure assertion**: a `track`/`identify` carrying an off-list PROPERTY key (e.g. a raw-PII field like `ssn` or `password` that Fernly never permits) triggers a loud failure — a vitest `expect(...).toThrow()` under the default `onViolation: 'throw'`. NOTE the guard gates property KEYS (not event names, not values): `enforceAllowlist` iterates `Object.keys(bag)` and throws on the first key not in the allowlist (VERIFIED `packages/analytics-kit/src/allowlist.ts`). **Taxonomy-vs-allowlist interaction (pin this):** if the props are taxonomy-typed, an undeclared key like `ssn` is a COMPILE error before it can be a runtime allowlist violation — which would block the test from building. To exercise the RUNTIME guard, route the off-list key through a path whose bag type admits arbitrary keys — the cleanest is **`register({ ssn: '...' })`**: `AnalyticsProviderImpl.register(props: NeutralProperties)` takes `Record<string, unknown>` (VERIFIED `packages/analytics-kit/src/neutral-event.ts` — `NeutralProperties = Record<string, unknown>`) and gates it through the SAME `allowed()` path, so `ssn` compiles and throws at runtime. Do NOT route it through `identify(id, traits)` — `traits` is taxonomy-typed `Partial<TX['traits']>`, so `ssn` is a compile error there. (A deliberate `as` cast on a `track` props object also works if you prefer showing the `track` path, with an explanatory line.) Pick the path that makes `.toThrow()` fire at runtime.
- A companion assertion for the `onViolation: 'drop-and-error-log'` policy branch (config-selected): the off-list event is dropped and nothing off-list reaches the recording adapter (assert the stream is clean).
- A runnable vitest test proving both branches: on-list keys pass through to the recorded stream; the off-list key throws (default) / is dropped-and-logged (configured).

### Out

- The merge/reset (S3), contexts (S4), node/query/react (S6/S7/S8).
- Re-testing the allowlist mechanism internals (E3-S2/S3 own that) — here it's a consumer-side executable demonstration.
- Any `packages/*` edit.

## Acceptance criteria

- [ ] An explicit `allowlist` is supplied via config only; on-list props reach the recorded stream.
- [ ] An off-list key triggers a loud failure under the default `throw` policy — proven by `expect(() => analytics.track(...)).toThrow()`.
- [ ] Under `onViolation: 'drop-and-error-log'`, the off-list event is dropped — nothing off-list reaches the recording adapter (asserted on a clean stream).
- [ ] `turbo run typecheck` + `turbo run test` pass for `examples/fernly` (bar B: policy is consumer config, enforcement is the library).
- [ ] **Bar-B diff invariant (enforced):** this story's changeset touches only `examples/**` — nothing under `packages/**`, verifiable by diff. If a required capability appears missing, it is a **bar-B failure** — file it as a bug against the owning epic (E2–E9) per the epic Notes; do NOT patch `packages/*` in E10.

## Technical notes

- **The allowlist gate is facade-owned (E3), runs against any adapter.** `AnalyticsProviderImpl.allowed()` → `enforceAllowlist(allowlist, onViolation, ...bags)` (`packages/analytics-kit/src/analytics-provider.ts` + `packages/analytics-kit/src/allowlist.ts`, both exported from `analytics-kit`). It gates `track`/`page`/`identify`/`group`/`register`/`setTraits`. `ViolationPolicy` is `'throw' | 'drop-and-error-log'`, default `'throw'`.
- **Config surface:** `AnalyticsConfig.allowlist?: string[]` + `onViolation?: ViolationPolicy` (VERIFIED `packages/analytics-kit/src/create-analytics.ts`). When `allowlist` is `undefined` the guard is a pass-through (no gating — `enforceAllowlist` returns `true`), so the allowlist MUST be explicitly set for the loud failure to fire. `deriveAllowlistFromTaxonomy(taxonomy)` is exported from `analytics-kit` — optionally show the derive-from-taxonomy path as an alternative to a hand-written list. NOTE it collects keys from `events` props + `traits` + `groups` props only — it does NOT include `page` prop keys (VERIFIED `packages/analytics-kit/src/allowlist.ts`); if a slice tracks `page` props under a derived allowlist, add those page keys explicitly.
- **Loud failure IS the point** — epic (2026-07-07): a deliberate off-list key (e.g. a raw-PII field) triggers a loud failure (throw by default), demonstrated as an executable assertion. Pick an obviously-PII off-list key so the intent reads clearly (e.g. `ssn`).
- **Runs against the mock (shape A).** Facade behavior — injected recording adapter via the seam factory; the `drop-and-error-log` branch is proven by asserting the recording adapter received nothing off-list.

## Shipped
- > Reviewer suggestion (2026-07-09, optional): a one-line note at the config defs that all configs set `key` (so the RecordingAdapter, not Noop, is wired) would make that load-bearing invariant explicit against a future config-copy mistake.
- > Reviewer suggestion (2026-07-09): the drop-branch relies on `emitViolation` passing a single string to `console.error` — if E3 ever switches to structured args, `stringContaining` on the first arg still holds; noting the intentional message-format coupling.

## Shipped

> Captured by `implement-epics` on 2026-07-09. E3's privacy contract as an executable consumer-side proof (bar B).

- **Files added (examples ONLY — bar B):** `allowlist-loud-failure.test.ts` (7 tests) — NO source change; policy = consumer config, enforcement = library.
- **New public API:** none — example-only. ZERO `packages/**` edits (bar B).
- **The loud-failure crux + compile-vs-runtime pin:** off-list PII key `ssn` → `expect(() => analytics.register({ssn})).toThrow()` under default `throw`. **Routed through `register`** (`props: NeutralProperties = Record<string,unknown>` → `ssn` COMPILES) NOT `identify(id, traits)`/taxonomy-typed `track` (where `ssn` is a COMPILE error blocking the build). The throw fires BEFORE the adapter (`allowed()` gates in `register` before `adapter.register`) — recorder stays empty (no side-effect, genuine not incidental). Reviewer traced against the real interface signatures.
- **drop-and-error-log branch:** config-selected `onViolation:'drop-and-error-log'` → off-list `register({ssn})` DROPPED (recorder clean) + `console.error` logged (spied/restored); on-list registers still record under drop (regression pin).
- **derive-from-taxonomy + gotcha proved:** `deriveAllowlistFromTaxonomy(fernlyTaxonomy)` contains event/trait/group keys, OMITS `page` keys (`path`/`referrer` — `not.toContain`, and the hand-written list adds them back — the omission demonstrated as a real consumer consequence); a harness from the derived list gates `ssn` identically. Undefined-allowlist→pass-through regression pin (allowlist MUST be explicitly set to gate).
- **Tests added:** fernly +7 (allowlist config-only on-list-passes, on-list register through, off-list throws no-side-effect, drop-and-error-log drops+logs, on-list-under-drop, derive-omits-page + gates-ssn, undefined-passthrough) → 56; turbo typecheck+test green; bar-B holds
- **Commit:** `E10-S5-allowlist-loud-failure — Allowlist contents + the deliberate off-list-key loud-failure assertion` on `core-cycle`
- **Reviewer notes:** ship-ready — 0 critical, 2 optional suggestions
- **Cross-story seams exposed (S6):** node server capture is `← S2 only` (no dependency on this browser recording harness) — a DIFFERENT target: `@analytics-kit/node` `capture(distinctId, 'plan_upgraded', props, {dedupeId})` on the SAME distinct id used client-side, `await shutdown()` in a signal handler (browser+node siblings, E7). Same bar-B: config-only, `examples/**` only.
