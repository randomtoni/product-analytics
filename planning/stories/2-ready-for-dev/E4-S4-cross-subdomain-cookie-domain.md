---
id: E4-S4-cross-subdomain-cookie-domain
epic: E4-ID-identity-persistence
status: ready-for-dev
area: identify
touches: [browser]
depends_on: [E4-S2-persistence-store-modes, E4-S3-durable-consent-lifecycle]
api_impact: additive
---

# E4-S4-cross-subdomain-cookie-domain — Config-authoritative cookie domain + gated public-suffix probe

## Why

Pre-login funnels stitch across subdomains only if the identity cookie is shared at the right domain scope. The consumer supplies the authoritative domain; the library auto-probes only as a fallback — and the throwaway probe cookies must never be written when the user hasn't consented.

## Scope

### In

- Config-supplied `cookieDomain` is authoritative for cross-subdomain sharing; add `cookieDomain?: string` (+ a cookie-scope option, e.g. `crossSubdomainCookie?: boolean`) to `AnalyticsConfig` (additive).
- Public-suffix auto-probe (`chooseCookieDomain` / `seekFirstNonPublicSubDomain`, de-branded) as FALLBACK only when `cookieDomain` is unset.
- The probe is GATED behind S3's consent-first read: no throwaway `dmn_chk_*`-style cookie is written when consent is denied / pending.
- The cookie half mirrors only identity/session keys across the domain (the bulk stays in localStorage per S2).

### Out

- Cross-tab session / persistence synchronization — explicitly deferred (later hardening slice).
- The persistence modes themselves — **S2**.
- The consent-first read mechanism — **S3** (this story consumes it).

## Acceptance criteria

- [ ] With `cookieDomain` set, the identity cookie is written at that domain; a simulated cross-subdomain journey keeps ONE distinct id.
- [ ] With `cookieDomain` unset, the public-suffix probe derives a domain; with it set, the probe does NOT run (config authoritative).
- [ ] Opted-out / pending: the probe writes ZERO throwaway cookies (gated by S3's consent-first read).
- [ ] The de-branded probe emits no vendor-named cookie; `grep -ri posthog packages/browser/src` clean.
- [ ] `cookieDomain` + scope are config-only; the library hardcodes no domain (bar B).
- [ ] jsdom tests; `pnpm --filter @analytics-kit/browser` gates green.

## Technical notes

- **Explicit `cookieDomain` authoritative, probe is fallback (— architect 2026-07-07):** the eTLD public-suffix probe (throwaway `dmn_chk_*` cookies) is fragile; the consumer supplies the domain per BRIEF, the probe only de-risks the missing-config case.
- **Probe gated by the consent-first read (Q5a):** the probe itself sets throwaway cookies, so it must sit behind S3's construction-time consent gate — this is why this story depends on S3, and why S3 is drafted before it (see S3's sequencing note).
- **De-brand the probe cookie name:** rename `dmn_chk_*` to a neutral role name; no `$` / `ph_` tokens.
- reference: `posthog-js/packages/browser` cookie-domain helpers (`seekFirstNonPublicSubDomain` / `chooseCookieDomain`); de-brand.

## Shipped

<!-- Empty at draft. /implement-epics fills this once, when the story moves to stories/5-done/
(files changed/added, new public API, tests added, commit, reviewer notes). Do not hand-edit. -->
