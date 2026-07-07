---
id: E10-CORE-example-consumer
status: planned
area: core
touches: [identify, capture, browser, node, react, query, privacy]
api_impact: additive
blocked_by: [E6-CAP-capture-enrichment, E7-NODE-server-capture, E8-QRY-query-client, E9-RCT-react-binding]
updated: 2026-07-07
---

# E10-CORE-example-consumer — Generic example consumer (proves bar B)

## Why

Bar B — new-app adoption = config only, zero library change — is one of the two acceptance tests of the whole release, and the only executable proof of it is a real consumer that adopts the library through config + generics alone. The first *real* consumer integrates in its own repo, so this repo ships a generic example of an **invented product** to hold bar B honest end-to-end. See `research/ARCHITECT-RELEASE1.md` (§E10/E11).

## Success criteria

The example is an invented, fictional B2B product — **Fernly**, a team document-review tool (a person is a *reviewer* who belongs to a *workspace* and optionally a *team*) — living entirely under `examples/fernly/`. It exercises, through config + generics ONLY:

- **Zero library change.** Building and running the example requires **no** edit to any `packages/*` source; it depends only on the published package entry points (`analytics-kit`, `@analytics-kit/{browser,node,react}`) plus the consumer's own config and generics. This is bar B and it is non-negotiable (see ## Notes).
- **Concrete taxonomy.** A `defineTaxonomy<T>()` declares Fernly's own events (`signup_started`, `signup_completed`, `document_uploaded`, `review_requested`, `comment_added`, `review_completed`, `plan_upgraded`) with per-event prop types; `track`/`page`/`group` calls are type-checked against it. The library ships zero event names.
- **Identity mapping.** Fernly's actor model is expressed only through the neutral primitives: reviewer → distinct id via `identify(id, traits, traitsOnce)`; workspace and team → `group('workspace', …)` / `group('team', …)`; role → a trait/prop. The library carries no notion of Fernly's roles.
- **Cookie domain + cross-subdomain.** A config-supplied `cookieDomain` (`.fernly.example`) stitches a marketing-site visit (`fernly.example`) to an app session (`app.fernly.example`) under one distinct id; a **simulated anonymous→identified merge across the two subdomains** preserves the id (exercises E4).
- **Named contexts + capture profiles.** At least two named contexts — `marketing` (autocapture on, auto pageview) and `app` (autocapture off, manual router-driven pageview) — are resolved from config; the active context applies its profile while sharing identity/session/transport, so cross-context funnel stitching survives (exercises E6).
- **Allowlist + loud off-list failure.** An explicit `allowlist` enumerates the permitted prop/trait keys; a deliberate off-list key (e.g. a raw-PII field) triggers a **loud failure** (throw by default), demonstrated as an executable assertion (exercises E3).
- **Server-side capture on the same distinct id.** A node-side handler captures a server-truth event (`plan_upgraded`) keyed on the **same** distinct id used client-side, carrying an insert/dedupe id for idempotent retries (exercises E7).
- **KPI/snapshot definitions using each query method.** Snapshot definitions call **every** query primitive — `funnel` (activation), `retention` (cohort→return), `trend` (engagement), `uniqueCount` (active reviewers), and the `rawQuery` escape hatch — each returning the snapshot-shaped result a persistence job expects. Snapshot storage + KPI definitions live in the example, not the library (exercises E8).
- **Framework wiring via the React binding.** The app is wired with `@analytics-kit/react` (`<AnalyticsProvider>` + `useAnalytics()`), with manual router-driven `page()` calls (exercises E9).
- **Runs against a mock adapter.** The whole harness runs against a mock/in-memory adapter, never a real backend — and that IS the bar-B proof, not an integration test.

## Stories

Tentative slice (story files not yet written):

- **E10-S1** — scaffold `examples/fernly/` wired to a mock/in-memory adapter; headless no-op with no key (E2).
- **E10-S2** — Fernly taxonomy via `defineTaxonomy<T>()` + identity mapping (reviewer/workspace/team/role) onto `identify`/`group`/`setTraits` (E3, identify).
- **E10-S3** — cross-subdomain cookie config + a simulated `marketing → app` anonymous→identified merge journey; `reset()` clears identity (E4).
- **E10-S4** — named contexts + capture profiles (`marketing` vs `app`), sharing identity/session/transport (E6).
- **E10-S5** — allowlist contents + the deliberate off-list-key loud-failure assertion (E3, privacy).
- **E10-S6** — node-side server capture of `plan_upgraded` keyed on the same distinct id, with a dedupe/insert id (E7).
- **E10-S7** — KPI/snapshot definitions calling `funnel`/`retention`/`trend`/`uniqueCount`/`rawQuery`, each returning the snapshot shape (E8).
- **E10-S8** — React/Next wiring: `<AnalyticsProvider>` + `useAnalytics()` + manual router-driven `page()` (E9).

## Out of scope

- The first **real** consumer — it integrates in its own repo; this epic ships only the generic invented example.
- The README interface→implementation matrix, the adopt-in-a-new-app guide, and the bar-A/bar-B audit + vendor-name scan — those are **E11-CORE-adoption-audit**.
- Any real backend endpoint/key wiring — the example proves adoption against a mock adapter only.

## Notes

- **Bar-B rule (locked, load-bearing).** The example adopts through config + generics only. If writing it requires ANY change to `packages/*`, that is a **bar-B failure, not a fix** — file it as a bug against the epic that owns the missing capability (E2–E9) and do **not** patch the library in this epic. E10 changes nothing under `packages/`.
- Fictional product: **Fernly** is invented and neutral (chosen to resemble no real product). Its names appear ONLY under `examples/` and must never leak into `packages/` — enforced by the E11 vendor/product-name scan.
- — architect (2026-07-07): prove the harness against a **mock/in-memory adapter, never a real backend** — that is what makes it bar B rather than an integration test.
- — architect (2026-07-07): this repo ships only the invented generic example; the first real consumer integrates in its own repo.
- — architect (2026-07-07): each exercised capability maps to the epic it proves — no-op→E2, taxonomy+allowlist→E3, merge/reset/cross-subdomain→E4, capture profiles→E6, server capture→E7, query methods→E8, React wiring→E9.

## Expansion path

The example is the template every future real consumer copies. Adding a second backend (self-hosted, another vendor) is one new adapter behind the seam and requires **zero** edits to this example — that swap is exactly the bar-A demonstration E11 runs against this harness.
