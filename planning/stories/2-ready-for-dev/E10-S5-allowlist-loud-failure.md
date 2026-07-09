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
- A **deliberate off-list-key loud-failure assertion**: a `track`/`identify` carrying an off-list key (e.g. a raw-PII field like `ssn` or `password` that Fernly never permits) triggers a loud failure — a vitest `expect(...).toThrow()` under the default `onViolation: 'throw'`.
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

## Technical notes

- **The allowlist gate is facade-owned (E3), runs against any adapter.** `AnalyticsProviderImpl.allowed()` → `enforceAllowlist(allowlist, onViolation, ...bags)` (`packages/analytics-kit/src/analytics-provider.ts` + `packages/analytics-kit/src/allowlist.ts`, both exported from `analytics-kit`). It gates `track`/`page`/`identify`/`group`/`register`/`setTraits`. `ViolationPolicy` is `'throw' | 'drop-and-error-log'`, default `'throw'`.
- **Config surface:** `AnalyticsConfig.allowlist?: string[]` + `onViolation?: ViolationPolicy` (`packages/analytics-kit/src/create-analytics.ts`). `deriveAllowlistFromTaxonomy(taxonomy)` is exported from `analytics-kit` — optionally show the derive-from-taxonomy path as an alternative to a hand-written list.
- **Loud failure IS the point** — epic (2026-07-07): a deliberate off-list key (e.g. a raw-PII field) triggers a loud failure (throw by default), demonstrated as an executable assertion. Pick an obviously-PII off-list key so the intent reads clearly (e.g. `ssn`).
- **Runs against the mock (shape A).** Facade behavior — injected recording adapter via the seam factory; the `drop-and-error-log` branch is proven by asserting the recording adapter received nothing off-list.

## Shipped
