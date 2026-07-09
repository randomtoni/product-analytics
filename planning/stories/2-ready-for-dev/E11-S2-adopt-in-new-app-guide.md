---
id: E11-S2-adopt-in-new-app-guide
epic: E11-CORE-adoption-audit
status: ready-for-dev
area: core
touches: [observability]
depends_on: [E11-S5-vendor-name-scan]
api_impact: additive
---

# E11-S2-adopt-in-new-app-guide — "Adopt in a new app" config-only guide

## Why

Bar B — new-app adoption = config only, zero library change — needs a walkable path a new consumer can follow using config + generics alone. This guide is that path, seeded by the E10 Fernly example (the working proof that config-only adoption holds).

## Scope

### In

- A README section walking a new consumer through adoption via **config + generics only**, covering each lever the library exposes:
  - typed taxonomy (`defineTaxonomy` / the `TX` generic — consumer declares its own events/traits/groups/page props);
  - identity mapping (consumer maps its model onto `identify` / `group` / event props);
  - cookie domain + scope (cross-subdomain), persistence mode;
  - named contexts + capture profiles (`context()` → scoped view);
  - the payload allowlist (consumer-supplied keys; enforcement is the library's);
  - KPI / snapshot definitions over the query client (`funnel`/`retention`/`trend`/`uniqueCount`/`rawQuery`);
  - framework wiring (the optional `@analytics-kit/react` binding — provider + hooks).
- Each lever states: what the consumer supplies (config/generics) vs what the library owns (the mechanism) — reinforcing "mechanisms from the library, contents from the consumer."
- A pointer to `examples/fernly` as the runnable reference for the whole path.

### Out

- The interface→implementation matrix — that is E11-S1.
- Building any new config surface — the guide documents the EXISTING config levers as shipped; if a lever is missing that a new app needs, that is a bug against the owning epic, not new work here.
- Product-specific guidance — the guide is generic; Fernly is only cited as the reference, its product specifics stay in `examples/`.

## Acceptance criteria

- [ ] The guide walks every config/generics lever the library exposes for adoption (taxonomy, identity mapping, cookie domain/scope, persistence mode, contexts + profiles, allowlist, KPI/snapshot defs, framework wiring) — each traceable to a real shipped config field or generic.
- [ ] The guide asserts the bar-B invariant explicitly: a new app adopts with ZERO edits under `packages/**` — grounded in the E10 Fernly example, which does exactly this.
- [ ] The guide lives inside the S5 scan coverage and PASSES it: it describes levers by neutral role, cites no vendor name, and (per the scan) uses the invented product `fernly` ONLY as a link to `examples/` — the product name must not appear as library-surface prose (see Technical notes on the Fernly exclusion nuance).
- [ ] Every config field / generic the guide references resolves to a real export (`AnalyticsConfig`, `defineTaxonomy`, `context()`, `enforceAllowlist`/allowlist config, the query client, the React binding) — no aspirational config.

## Technical notes

- **Bar-B grounding = E10 Fernly** (`examples/fernly`): a workspace member whose `turbo typecheck`-against-`dist` gate IS the bar-B proof (config-only adoption, one taxonomy across every surface, zero `packages/**` edits). The guide generalizes what Fernly did into a consumer-agnostic walkthrough. Config levers to reference: `packages/analytics-kit/src/create-analytics.ts` (`AnalyticsConfig`, `CaptureProfile`, `EnrichmentConfig`, `CountryEnrichmentConfig`), `defineTaxonomy` + `ShapeOf` (taxonomy), `context()` on `RootAnalytics` (named contexts), `enforceAllowlist`/`deriveAllowlistFromTaxonomy` (allowlist), `@analytics-kit/node` `createQueryClient` (KPI/snapshot defs), `@analytics-kit/react` (`AnalyticsClientProvider`/`useAnalytics`/`usePageView`).
- **Docs land in the root `README.md`** (locked, same as S1) — this is a section appended after the S1 matrix.
- **Fernly-in-docs nuance (from S5 scan):** the scan forbids `fernly` in library-surface doc PROSE but the guide legitimately needs to POINT at `examples/fernly` as the runnable reference. Resolve by referencing it as a path/link (`examples/fernly`) — a repo path, not library prose — and keep the narrative product-neutral. Flag to the builder: if the scan's fernly rule can't distinguish a path-link from prose, coordinate the exact allowance with S5 (the scan owns the rule; the guide conforms). This is why S2 `depends_on` S5.
- **Executable-vs-prose:** this is PROSE docs (an adoption narrative is inherently narrative). Its bar-B CLAIM is separately GATED by S4's bar-B verification (the Fernly diff-is-`examples/**`-only assertion) — the guide asserts config-only adoption; S4 proves it re-runnably.
- Describe-by-role constraint applies (same as S1): levers named by neutral role, zero vendor references, no `$`-prefixed wire literals in prose.

## Shipped
