---
id: E3-S3-allowlist-source-derivation
epic: E3-CORE-taxonomy-allowlist
status: ready-for-dev
area: core
touches: [privacy]
depends_on: [E3-S1-define-taxonomy-typed-facade, E3-S2-allowlist-guard]
api_impact: additive
---

# E3-S3-allowlist-source-derivation — Allowlist derivation + the consumer-supplied-value-gated path

## Why

Closes the allowlist story. A consumer who already declared a taxonomy (S1) shouldn't hand-maintain a parallel key list, so `deriveAllowlistFromTaxonomy` walks the taxonomy's declared keys into an allowlist. And the "library computes ⇒ trusted; consumer supplies ⇒ gated" rule is pinned as a seam here — so E6's consumer-injected country source is gated by construction, not rediscovered as an E6 afterthought.

## Scope

### In

- `deriveAllowlistFromTaxonomy(taxonomy: Taxonomy<TaxonomyDecl>): string[]` — walks `decl.events` prop keys + `decl.traits` keys + `decl.groups` prop keys (`Object.keys`), returns a **deduped** `string[]`. Keys only; no event NAMES leak into the list.
- The two allowlist sources are **separable and composable**: a consumer may supply explicit `allowlist`, `deriveAllowlistFromTaxonomy(taxonomy)`, or both. When both are present they combine as a **union** (deduped). Kept separable because global/registered super-props live outside any single event's taxonomy entry — they arrive only via the explicit `allowlist`.
- The documented + tested rule: keys the library **computes** (enrichment added downstream, inside the adapter, after the guard) are implicitly allowed; keys/values the consumer **supplies** are gated. This is the "consumer-supplied value ⇒ gated" path: any value present in the props/traits at the facade call-boundary is gated by S2's guard — whether the consumer typed it directly or a consumer-config value-producer injected it before the guard.
- A test that simulates the E6 injected-value case: a consumer-supplied value with an off-list key is rejected by the guard; on-list, it passes — proving the seam E6 conforms to.

### Out

- The E6 country enrichment itself, and other enrichment (page/UTM/device) — **E6**. S3 establishes only the gated-path contract/seam and its test.
- Super-property *registration* mechanics — **E4** (identity owns registration); S3 only ensures the allowlist is aware of super-prop keys via the explicit `allowlist`.
- Moving the guard's position — it stays at the facade call-boundary (S2).

## Acceptance criteria

- [ ] `deriveAllowlistFromTaxonomy(taxonomy)` returns exactly the deduped union of all declared event-prop keys + trait keys + group-prop keys; no event NAMES appear in the result.
- [ ] Explicit `allowlist` and `deriveAllowlistFromTaxonomy` are separable and composable (union, deduped): a super-prop key supplied only via explicit `allowlist` (present in no event) still passes the guard; a taxonomy-derived key passes without being restated in the explicit list.
- [ ] A consumer-injected value (simulating E6's country source) with an off-list key is rejected by the S2 guard; on-list, it passes — proving the "consumer-supplied ⇒ gated" path.
- [ ] A library-computed enrichment key (stamped by a mock adapter downstream of the guard) is NOT rejected — implicitly allowed — proven with a mock adapter that adds a computed key after `capture`.
- [ ] The derivation is unit-tested against a fixture taxonomy; the composition + gating are tested against a mock/spy adapter, never a real backend.
- [ ] `grep -ri posthog packages/analytics-kit/src` clean; `pnpm --filter analytics-kit typecheck`, `lint`, `test`, `build` exit 0.

## Technical notes

- **Derivation shape (— architect 2026-07-07, Q1):** walk `t.decl.events` (each `PropDecl`'s keys), `t.decl.traits`, and `t.decl.groups`, collecting into a `Set<string>`, return `[...keys]`. The `Taxonomy<T>.decl` runtime object from S1 is exactly the walkable registry this needs — this is why S1 returns a runtime object rather than a bare generic.
- **Keep the two sources separable (— architect 2026-07-07, epic Notes):** explicit `allowlist: string[]` + optional `deriveAllowlistFromTaxonomy(taxonomy)`, composed as a union. Separable because global/registered super-props exist outside any single event's taxonomy entry; folding derivation into a single mandatory source would strand super-prop keys.
- **The consumer-supplied-value-gated path — design it here, not as an E6 afterthought (— architect 2026-07-07, epic Notes):** rule — keys the library **computes** are trusted; keys OR values the consumer **supplies** (event props, traits, injected enrichment) are gated. The seam is the S2 guard's position: it gates every key present in the props/traits at the call-boundary. So E6's country source, if injected via a consumer-config value-producer that runs BEFORE the guard, is gated automatically and its key must be on-list; if instead the adapter computes it downstream, it's trusted. S3 pins this contract + a test simulating an injected consumer value; it does not build E6's injection hook.
- **Union composition (PM 2026-07-07):** when both `allowlist` and a derived list are supplied, merge to a deduped union — the most permissive-of-declared, least-surprising behavior (a consumer who both declares a taxonomy and lists extra super-props expects both to pass). Empty/undefined sources contribute nothing.
- **No posthog-js analogue** — the allowlist and its derivation are entirely the library's own surface. Ground in the S1 `Taxonomy`/`TaxonomyDecl` shape and the S2 guard, not in `posthog-js`.

## Shipped
