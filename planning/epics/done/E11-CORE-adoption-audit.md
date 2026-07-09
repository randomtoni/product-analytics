---
id: E11-CORE-adoption-audit
status: done
area: core
touches: [observability]
api_impact: additive
blocked_by: [E10-CORE-example-consumer]
updated: 2026-07-09
---

# E11-CORE-adoption-audit — Docs matrix + acceptance-bar audit

## Why

Both acceptance bars — (A) provider-swap = one adapter, zero consumer change; (B) new-app adoption = config only, zero library change — are the release's acceptance test, and they need a durable, re-runnable proof, not a one-time inspection. This epic ships the README matrix that makes "a new adapter is fill-in-the-blanks" concrete, plus an automated audit whose centerpiece is the vendor/product-name scan — the whole reason the library exists. See `research/ARCHITECT-RELEASE1.md` (§E10/E11, §E-cross).

## Success criteria

- **README interface→implementation matrix.** For every interface method — client (`track`, `identify`, `page`, `group`, `reset`, `setTraits`, `optIn`/`optOut`/`hasOptedOut`, `flush`, `shutdown`), node (`capture`, `setTraits`, `setGroupTraits`), and query (`funnel`, `retention`, `trend`, `uniqueCount`, `rawQuery`) — a row maps: **method → its ported (de-branded) implementation → the intended future warehouse/SQL or self-hosted implementation**, so a new adapter is genuinely fill-in-the-blanks.
- **"Adopt in a new app" config-only guide.** A README section walks a new consumer through adoption via config + generics only (taxonomy, identity mapping, cookie domain, contexts + profiles, allowlist, KPI/snapshot defs, framework wiring) — no library edits.
- **Bar A audit.** A hypothetical second adapter is designed **on paper**, confirming one-adapter, zero-consumer-change; and this is demonstrated concretely by swapping the ported HTTP adapter for the null adapter (or a second mock) against the E10 harness with **zero** example-consumer edits.
- **Bar B verification.** The E10 example is confirmed to adopt by config only, with zero edits under `packages/`.
- **Vendor/product-name scan (the critical gate), CI-able.** An automated check finds **zero** matches for: `posthog` (case-insensitive), `ph_`-prefixed names, `$`-prefixed wire property names, region/vendor hostnames (e.g. `i.posthog.com`), and the E10 invented-product names (`fernly`) — across **everything under `packages/` PLUS every shipped doc wherever it lives (the repo-root README, the interface→implementation matrix, the adopt-in-a-new-app guide)**: identifiers, type names, exports, file and package names, and docs, not source alone. Wired as an exit-nonzero, CI-runnable check — not a manual grep. (Dev tooling — `CLAUDE.md`, `.claude/`, `planning/`, `examples/` — is exempt; the reference checkout and port-source citations live there by design.)

## Stories

All five shipped to [`stories/5-done/`](../stories/5-done/). Built **S5 → S1 → S2 → S3 → S4** — S5 (the vendor-name scan) first because its confinement rule (describe-by-role, never by vendor) constrains what the docs stories write. Both acceptance bars now have **re-runnable gated proofs**, the neutrality guarantee is a durable CI gate, and the capability contract is audited complete with no silent gap — the R1 charter is verified end-to-end.

- **[E11-S5](../stories/5-done/E11-S5-vendor-name-scan.md)** *(done — `018c370`)* — the CI-able exit-nonzero vendor/product-name scan (`scripts/neutrality-scan.ts` + root `//#neutrality-scan` turbo task). Scan-by-DIMENSION (exported identifiers/types against `dist/index.d.{ts,mts}` — BOTH; package/file names; consumer strings; shipped docs), NOT raw grep. `$`-wire literals gated by a `/_WIRE_(EVENT|KEY)$/`-CONFINEMENT rule (fails an escaped literal, not a whitelist) via the TS compiler-API AST (literal-scoped — port-citation comments pass). Confinement runs over the shipped import graph (filename-approx). `examples/**`/`planning/**`/`.claude/**`/`posthog-js/**` exempt; port-citation `//` comments skip `posthog`. Reviewer INDEPENDENTLY verified (planted a real token in a real `.d.mts`→gate exited 1).
- **[E11-S1](../stories/5-done/E11-S1-interface-implementation-matrix.md)** *(done — `d6da39d`)* — README interface→implementation matrix: 15 client (13 verbs + `flags?`/`replay?`) + 3 node + 5 query rows → shipped de-branded impl (by role/wire shape) → future warehouse/SQL or self-hosted fill-in cell (grounded in the `AnalyticsAdapter` SPI + `WarehouseQueryAdapter`). Also corrected the pre-existing wrong "Usage (sketch)" (`capture`/`backend.writeKey`→real `track`/`AnalyticsConfig`). Passes the S5 scan.
- **[E11-S2](../stories/5-done/E11-S2-adopt-in-new-app-guide.md)** *(done — `68a7582`)* — README "Adopt in a new app" config-only guide walking every lever (taxonomy, identity, cookie/persistence, contexts/profiles, allowlist, KPI defs, framework wiring) each as consumer-supplies-vs-library-owns, + the bar-B ZERO-`packages/**` invariant grounded in `examples/fernly`. Every lever→real export; passes the S5 scan (`fernly` path-only).
- **[E11-S3](../stories/5-done/E11-S3-bar-a-adapter-swap-audit.md)** *(done — `b5dee2f`)* — **bar A** (provider-swap = one adapter, zero consumer change): a GATED swap test (same `createAnalytics(config, adapter, deps)` call site flows `NoopAdapter`↔`RecordingAdapter`, facade `keyof` byte-identical, difference behind the seam) + on-paper 2nd-adapter design over the real **18-member** `AnalyticsAdapter` SPI (corrected from the draft's "20"), citing the shipped `HttpQueryAdapter`+`WarehouseQueryAdapter` two-adapters-one-interface precedent.
- **[E11-S4](../stories/5-done/E11-S4-bar-b-and-capability-completeness.md)** *(done — `5cd7a32`)* — **bar B** (new-app adoption = config only): a GATED structural footprint check (`examples/fernly` no `paths`-into-src, `workspace:*` deps, `^build` wiring) + capability-completeness (a `planning/audit/` coverage table vs posthog-js scoped to the BRIEF contract, load-bearing by-design-omitted flags/replay/surveys/heatmaps rows) backed by a TYPECHECK-time export/type-presence tripwire over `dist` (`keyof`-equality — reviewer INDEPENDENTLY broke it 4 ways: drop/add/return-regression/dist-not-src). Frozen-15 pin held.

Built topo order: **S5 → S1 → S2 → S3 → S4** (S3/S4 independent). Both bars re-runnably gated (bar A = S3 swap test, bar B = S4 config-only test); the S5 neutrality scan is a standing CI gate over the whole surface.

## Out of scope

- Building the example consumer itself — that is **E10-CORE-example-consumer** (this epic audits it).
- The first **real** consumer (its own repo).
- **Fixing** anything the audit surfaces: a scan hit or a bar failure routes to the epic that owns the leak/gap as a bug — E11 documents and gates, it does not patch the library.

## Notes

- — architect (2026-07-07): the scan must span **source, public API, type names, package/file names, AND docs** — auditing only source is rejected. Include `$`-prefixed names and region hostnames (`i.posthog.com`), the strings most likely to slip through from ported code.
- Scan targets (locked): case-insensitive `posthog`; `ph_` cookie/name prefixes; `$`-prefixed wire property names; region/vendor hostnames; and the E10 invented-product names anywhere under `packages/` (they belong only in `examples/`). Zero matches required; CI-able exit-nonzero check, not a manual grep.
- Scan scope (locked): `packages/` + all shipped docs wherever they live — the repo-root README and both E11 doc deliverables fall INSIDE the scan. Consequence for E11-S1/S2: the matrix and guide describe each implementation by **role and wire shape** ("batch POST to the configured ingest host", "HTTP query endpoint, Bearer key"), never by vendor name; explicit posthog-js file:line references stay in dev tooling (`planning/`, `CLAUDE.md`), which is exempt.
- — architect (2026-07-07): bar A is demonstrated by swapping the ported HTTP adapter for the null adapter (or a second mock) with zero example edits; pair that concrete swap with the on-paper second-adapter design to confirm one-adapter-zero-consumer-change.
- Audit-not-patch (locked): E11 gates and documents; any bug it finds is filed against the responsible epic and fixed there, never patched inside this epic.

## Expansion path

The matrix gains a column and the scan gains no exceptions as each new adapter/target lands — every future backend fills in its own implementation cell and must still pass the same zero-vendor-name gate.
