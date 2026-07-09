---
id: E11-S4-bar-b-and-capability-completeness
epic: E11-CORE-adoption-audit
status: ready-for-dev
area: core
touches: [observability]
depends_on: []
api_impact: additive
---

# E11-S4-bar-b-and-capability-completeness — Bar B verification + capability-completeness check

## Why

Bar B — new-app adoption = config only, zero library change — is the other half of the acceptance test, and it needs a re-runnable proof, not a claim. Paired with it: the capability-completeness check that confirms nothing a mature SDK exposes is LOST by depending on this library (scoped to the BRIEF contract). Together they prove the library delivers on its charter — the capstone that closes the cycle.

## Scope

### In

- **Bar-B verification (gated):** a re-runnable assertion that the E10 example adopts by config ONLY — the example's contribution is `examples/**`-only, with ZERO edits under `packages/**`. Grounded in `examples/fernly`, whose `turbo typecheck`-against-`dist` gate already proves config-only adoption. This story makes bar-B a stated, checked audit outcome (e.g. an assertion that the example's footprint / diff is confined to `examples/**`, or a documented re-run of the Fernly gate as the bar-B proof).
- **Capability-completeness check** = a prose coverage table + a gated export/type-presence assertion (architect-locked shape — see Technical notes):
  - **Prose coverage table:** one row per BRIEF §Capability-contract line → the shipped neutral export/module that realizes it → the posthog-js reference it maps to (by role; this table lives in `planning/`/audit doc, exempt, so reference citations are fine here). Covers the 15-member client surface (13 verbs + the 2 declared-only `flags?`/`replay?` ports), the implicit capabilities (anon identity + persistence, enrichment, transport/reliability, autocapture), the 3 node verbs, the 5 query methods — AND a "typed extension point, not implemented — by design" row for flags/replay/surveys/heatmaps citing BRIEF §"Explicitly OUT". Scoped to the BRIEF contract, NOT everything PostHog ships.
  - **Gated export/type-presence assertion:** a `typecheck`-time check (the type surfaces are type-only exports — see Technical notes) that the frozen 15-member `AnalyticsProvider` surface (13 verbs + `flags?`/`replay?`) + the 3 node verbs + the 5 query methods are ACTUALLY present/shaped on the built `dist` type exports — the staleness tripwire that keeps the prose table honest.

### Out

- Proving semantic equivalence to PostHog by assertion — meaning stays in the prose table + reviewer judgment; the gate checks presence + shape only (architect-locked).
- Implementing any missing capability — a genuine gap routes to the owning epic as a bug (audit-not-patch).
- The interface→implementation matrix (S1) — the capability table argues COMPLETENESS against the reference; the matrix maps methods to impl cells. Different deliverables.

## Acceptance criteria

- [ ] A re-runnable check confirms bar B: the E10 example's footprint is `examples/**`-only, zero `packages/**` edits — grounded in the Fernly `turbo typecheck`-against-`dist` gate.
- [ ] The capability coverage table has one row per BRIEF §Capability-contract line, each mapped to a real shipped export + its posthog-js reference; the flags/replay/surveys/heatmaps rows are present and marked "typed extension point, by design — BRIEF §Explicitly OUT" (converting a gap into proven-intentional scope).
- [ ] A GATED assertion proves every frozen-15 member (13 methods + optional `flags?`/`replay?`), every node verb (`capture`/`setTraits`/`setGroupTraits`), and every query method (`funnel`/`retention`/`trend`/`uniqueCount`/`rawQuery`) is present on the BUILT `dist` type surface and correctly shaped, such that a rename/drop/signature-change FAILS `typecheck`. Because `AnalyticsProvider`/`NodeAnalytics`/`AnalyticsQueryClient` ship as TYPE-ONLY exports (interfaces, no runtime value — verified in every `dist/index.d.ts`), this member-presence assertion is necessarily TYPECHECK-time (a conditional-type / `keyof` / `satisfies` check importing the types from the package `dist` entry) — NOT a runtime `Object.keys` inspection, which cannot see an interface. The `flags?`/`replay?` optionality means the check asserts the INTERFACE DECLARES them (they exist in `keyof AnalyticsProvider`), not that any instance carries them (declared-only this release).
- [ ] The check confirms nothing in the BRIEF capability contract is LOST by depending on the library; anything absent is either a routed bug or an explicitly-by-design omission — no silent gap.
- [ ] Any prose lives inside the S5 scan coverage where it ships to a doc (the audit table in `planning/` is exempt; if any of it lands in the README it passes the scan).

## Technical notes

- **Bar-B grounding = E10 Fernly** (`examples/fernly`): the workspace member whose `turbo typecheck`-against-`dist` gate IS the bar-B proof — config-only adoption, one taxonomy every surface (browser merge/contexts/allowlist + node capture + query snapshots + React binding), zero `packages/**`. The check re-runs / asserts that footprint.
- **Capability-completeness shape — architect-locked (2026-07-09):** primarily a PROSE coverage table (the "nothing is lost" claim is a judgment mapping — no assertion can decide semantic equivalence), PLUS a cheap high-value gated slice: an export/type-presence assertion over the built `dist`. Freeze the contract as a literal list (15 client members + 3 node verbs + 5 query methods — counts verified against the shipped source, see below), import from each package's `dist` entry (not `src`, so it asserts what tsup actually ships), and assert presence + shape. **Split by export kind (verified in the `dist` bundles):** the three surface interfaces `AnalyticsProvider`/`NodeAnalytics`/`AnalyticsQueryClient` are TYPE-ONLY exports (`export { type AnalyticsProvider, … }`) — assert their member presence + shape at `typecheck` time (a conditional-type / `keyof` / `satisfies` check against the imported types; catches rename/signature drift, strongest + cheapest). Separately, a `dist`-RUNTIME presence check can only assert on actual VALUE exports — `createAnalytics`, `NoopAdapter`, `createQueryClient`, `HttpQueryAdapter`, `WarehouseQueryAdapter`, `defineTaxonomy` (proves tsup emitted the runtime entry) — it can NOT inspect the interfaces (there is no runtime `AnalyticsProvider` object). Do NOT try to `Object.keys()` a type. Do NOT try to gate meaning — that's the table's + reviewer's job; conflating them yields a brittle test that fails on cosmetics and still can't prove the claim.
- The "by-design-omitted" rows are load-bearing: they convert a raw gap ("we forgot replay") into documented-intentional scope ("replay is a non-goal with a declared `SessionReplayPort` extension seam"). Ports: `packages/analytics-kit/src/ports.ts`.
- Surfaces to ground the table: frozen-15 = `packages/analytics-kit/src/analytics-provider.ts`; node verbs = `packages/node/src/node-analytics.ts`; query methods = `packages/node/src/query/query-client.ts`; implicit capabilities span `packages/browser/src/**` (identity/persistence/transport/enrichment/autocapture). BRIEF §Capability contract (lines 72–139) is the frozen scope; posthog-js references map by role in the audit doc (exempt from the S5 scan).
- **Executable-vs-prose balance:** bar-B verification and the export/type-presence contract are GATED CHECKS; the capability coverage table is PROSE (a judgment mapping). This is the deliberate split the epic asks for — gate what's gateable, narrate what's judgment.
- No `depends_on`: grounds against already-shipped surfaces (E10 + the whole built `dist`), independent of S5 and the docs stories. Its coverage table lives in `planning/` (scan-exempt); only the bar-B assertion + presence gate are code.

## Shipped
