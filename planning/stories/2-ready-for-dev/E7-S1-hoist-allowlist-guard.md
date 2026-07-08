---
id: E7-S1-hoist-allowlist-guard
epic: E7-NODE-server-capture
status: ready-for-dev
area: node
touches: [core, privacy]
depends_on: []
api_impact: additive
---

# E7-S1-hoist-allowlist-guard — Hoist the allowlist guard into an exported neutral function

## Why

Node must enforce the SAME E3 payload allowlist as the browser (bar A: one privacy contract, off-list keys fail loudly server-side too). The enforcement lives today as a **private** `allowed()` method fused into the browser-shaped `AnalyticsProviderImpl` — node cannot import it without dragging in the whole facade. Hoist it into a standalone exported seam function so the browser facade and the node client share ONE privacy code path, not two copies that can drift.

## Scope

### In

- Extract the whole-bag enforcement currently in `AnalyticsProviderImpl.allowed()` (`packages/analytics-kit/src/analytics-provider.ts:271-287`) into a standalone, side-effect-free function exported from the seam — home it alongside `deriveAllowlistFromTaxonomy` in `packages/analytics-kit/src/allowlist.ts` (or a sibling module), exported from `packages/analytics-kit/src/index.ts`.
- Signature carries the existing semantics verbatim: takes the property bag(s), the allowlist (`ReadonlySet<string>` or `string[]`), and the `ViolationPolicy` (`'throw'` | `'drop-and-error-log'`); on an off-list key it THROWS (`throw` policy) or emits the `console.error` violation + returns a "dropped" signal (`drop-and-error-log`). Undefined allowlist ⇒ everything allowed (unchanged). The `emitViolation` console sink moves with it.
- Repoint `AnalyticsProviderImpl.allowed()` to delegate to the hoisted function — behavior-preserving, a thin wrapper over the shared implementation.
- Keep the existing guard tests green through the move (`allowlist-guard.test.ts`); add direct unit coverage of the exported function if it lands in a new module.

### Out

- The node client class, node capture, node batching (E7-S2+).
- ANY change to the guard's semantics: it inspects `Object.keys` only (never values, never event names). Preserve that exactly — it is what keeps the guard target-agnostic. Do NOT let node-specific concerns leak into it in this story.
- Renaming `deriveAllowlistFromTaxonomy` or touching taxonomy typing.

## Acceptance criteria

- [ ] A standalone allowlist-enforcement function is exported from `analytics-kit` (public surface), callable without instantiating `AnalyticsProviderImpl`.
- [ ] `AnalyticsProviderImpl.allowed()` delegates to the hoisted function; the browser path behaves identically (existing `allowlist-guard.test.ts` + `analytics-provider.test.ts` stay green).
- [ ] The hoisted function preserves both `ViolationPolicy` branches verbatim: `throw` raises the same `Error` message; `drop-and-error-log` emits the same `console.error` and signals drop.
- [ ] The function inspects property-bag KEYS only — no value inspection, no event-name coupling — so it is reusable server-side unchanged (bar A: one privacy contract for every adapter/target).
- [ ] All four gates green (`typecheck` / `lint` / `test` / `build`).

## Technical notes

- Shape decision (A) + this hoist — architect (2026-07-08): node ships its OWN thin client and reuses the seam only for taxonomy typing + the allowlist POLICY. The guard is NOT importable today (only `deriveAllowlistFromTaxonomy` is exported; enforcement is the private `allowed()`). Hoisting it to an exported neutral function is the seam sub-task that makes bar A literally one code path. It is behavior-preserving and fully covered by existing tests — land it FIRST, then node (E7-S2) consumes it.
- The current implementation to extract, verbatim semantics: `AnalyticsProviderImpl.allowed()` at `analytics-kit/src/analytics-provider.ts:271-287` (whole-bag loop over `Object.keys`, throw-vs-drop-and-error-log via `ViolationPolicy`, `emitViolation` at line 34). `ViolationPolicy` (`'throw' | 'drop-and-error-log'`) is already exported from `analytics-provider.ts`.
- Natural home: `packages/analytics-kit/src/allowlist.ts` (already holds `deriveAllowlistFromTaxonomy`). Export the new function from `packages/analytics-kit/src/index.ts` alongside it.
- Keep neutral: the guard's semantics are defined purely over property bags — nothing browser- or node-specific. This is exactly why it hoists cleanly; keep it that way.
- api_impact additive: a new export, no removed/renamed API. The private `allowed()` becoming a delegate is internal.

## Shipped
