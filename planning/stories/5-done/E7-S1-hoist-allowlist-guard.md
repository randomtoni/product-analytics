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
- **Also export `PropsParam` from the seam** (`packages/analytics-kit/src/index.ts`): it is defined in `taxonomy.ts:67` but currently NOT re-exported from the package entrypoint. A one-line additive `export type` alongside the existing `ShapeOf`/`TaxonomyShape` exports — no code change. This piggybacks on S1 (the only seam-touching `[core]` story that lands before the node stories) so a downstream target package can reuse the seam's props-param type rather than re-deriving it. (Note: E7-S2's chosen `capture` overload shape does NOT strictly require `PropsParam` — it uses `TX['events'][K]` directly — so this export is seam-completeness, not a hard S2 blocker. Keep it; it costs nothing and closes an obvious export gap.)
- Keep the existing guard tests green through the move (`allowlist-guard.test.ts` + `analytics-provider.test.ts`); add direct unit coverage of the exported function if it lands in a new module.

### Out

- The node client class, node capture, node batching (E7-S2+).
- ANY change to the guard's semantics: it inspects `Object.keys` only (never values, never event names). Preserve that exactly — it is what keeps the guard target-agnostic. Do NOT let node-specific concerns leak into it in this story.
- Renaming `deriveAllowlistFromTaxonomy` or touching taxonomy typing.

## Acceptance criteria

- [ ] A standalone allowlist-enforcement function is exported from `analytics-kit` (public surface), callable without instantiating `AnalyticsProviderImpl`.
- [ ] `PropsParam` is re-exported from the seam entrypoint (`packages/analytics-kit/src/index.ts`) so a downstream target package can import it (currently defined in `taxonomy.ts` but not exported).
- [ ] `AnalyticsProviderImpl.allowed()` delegates to the hoisted function; the browser path behaves identically (existing `allowlist-guard.test.ts` + `analytics-provider.test.ts` stay green).
- [ ] The hoisted function preserves both `ViolationPolicy` branches verbatim: `throw` raises the same `Error` message; `drop-and-error-log` emits the same `console.error` and signals drop.
- [ ] The function inspects property-bag KEYS only — no value inspection, no event-name coupling — so it is reusable server-side unchanged (bar A: one privacy contract for every adapter/target).
- [ ] All four gates green (`typecheck` / `lint` / `test` / `build`).

## Technical notes

- Shape decision (A) + this hoist — architect (2026-07-08): node ships its OWN thin client and reuses the seam only for taxonomy typing + the allowlist POLICY. The guard is NOT importable today (only `deriveAllowlistFromTaxonomy` is exported; enforcement is the private `allowed()`). Hoisting it to an exported neutral function is the seam sub-task that makes bar A literally one code path. It is behavior-preserving and fully covered by existing tests — land it FIRST, then node (E7-S2) consumes it.
- The current implementation to extract, verbatim semantics: `AnalyticsProviderImpl.allowed()` at `analytics-kit/src/analytics-provider.ts:271-287` (whole-bag loop over `Object.keys`, throw-vs-drop-and-error-log via `ViolationPolicy`, `emitViolation` at line 34). `ViolationPolicy` (`'throw' | 'drop-and-error-log'`) is already exported from `analytics-provider.ts`.
- **Multi-bag varargs signature — preserve it.** The current `allowed(...bags: Array<NeutralProperties | undefined>)` accepts N bags and short-circuits on the first off-list key (the browser `identify` path passes TWO bags: `traits` + `traitsOnce`, `:186`). The hoisted function must keep the variadic/multi-bag shape (not a single-bag signature) so both call sites — browser's 2-bag identify AND node's single-bag capture/traits — reuse the identical function. It reads `undefined` bags as skip (`:275`) — keep that.
- **Return contract.** The function returns `boolean` (`true` = all keys allowed / continue; `false` = a key was dropped under `drop-and-error-log`; `throw` never returns). Callers guard-early-return on `false` (`if (!allowed(...)) return;`). Preserve this exact contract so `AnalyticsProviderImpl.allowed()` delegates as `return hoistedFn(this.allowlist, this.onViolation, ...bags)` with zero behavior change.
- Natural home: `packages/analytics-kit/src/allowlist.ts` (already holds `deriveAllowlistFromTaxonomy`). Export the new function from `packages/analytics-kit/src/index.ts` alongside it.
- Keep neutral: the guard's semantics are defined purely over property bags — nothing browser- or node-specific. This is exactly why it hoists cleanly; keep it that way.
- api_impact additive: a new export, no removed/renamed API. The private `allowed()` becoming a delegate is internal.

## Shipped
- > Reviewer suggestion (2026-07-08, stylistic): the private `allowed()` delegate is now a pure pass-through — could inline `enforceAllowlist(this.allowlist, this.onViolation, ...)` at the 8 call sites, but the private method (capturing the two fields) is arguably clearer. No change required.

## Shipped

> Captured by `implement-epics` on 2026-07-08.

- **Files changed (seam):** `allowlist.ts` (+exported side-effect-free `enforceAllowlist(allowlist, onViolation, ...bags): boolean` — the whole-bag guard, byte-identical loop; moved `emitViolation`/`ConsoleLike` here), `analytics-provider.ts` (`allowed()` → thin delegate `return enforceAllowlist(this.allowlist, this.onViolation, ...bags)`; `ViolationPolicy` stays defined/exported here, type-only back-imported), `index.ts` (+`enforceAllowlist` value export, +`PropsParam` type export — both additive)
- **New public API:** `enforceAllowlist` (standalone guard, callable without instantiating the impl — the shared privacy path for node) + `PropsParam` (re-export). Pin stays 15 (no facade verb). `deriveAllowlistFromTaxonomy` untouched.
- **Behavior-preserving:** variadic multi-bag (browser `identify` 2-bag rides unchanged), `undefined`-bag skip, `boolean` contract (`true`/`false`/throw), BOTH `ViolationPolicy` branches verbatim (same Error message + `console.error`), undefined-allowlist⇒all-allowed, KEYS-only (no value/event-name coupling — keeps it target-agnostic).
- **Tests added:** seam +14 (allowlist +12: standalone-callable, both branches verbatim, multi-bag catch + short-circuit, undefined-allowlist, undefined-bag-skip, empty-set-activates, keys-only; index +2: enforceAllowlist + PropsParam exported) → 166; browser 584 (facade gate unchanged — no regression)
- **Commit:** `E7-S1-hoist-allowlist-guard — Hoist the allowlist guard into an exported neutral function` on `core-cycle`
- **Reviewer notes:** 0 critical, 2 stylistic/hygiene suggestions
- **Cross-story seams exposed (S2):** node imports `import { enforceAllowlist } from 'analytics-kit'` + `import type { PropsParam, ViolationPolicy, NeutralProperties }`. Node calls `enforceAllowlist(allowlist, onViolation, props)` single-bag with the same `if (!enforceAllowlist(...)) return;` early-return; builds its own `ReadonlySet<string>` allowlist (via `deriveAllowlistFromTaxonomy` or consumer `string[]`) + own `ViolationPolicy` default. Stateless + target-agnostic — no impl instantiation. **Bar A is now literally ONE code path** browser + node share.
