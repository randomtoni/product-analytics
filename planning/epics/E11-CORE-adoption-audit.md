---
id: E11-CORE-adoption-audit
status: planned
area: core
touches: [observability]
api_impact: additive
blocked_by: [E10-CORE-example-consumer]
updated: 2026-07-07
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

Tentative slice (story files not yet written):

- **E11-S1** — README interface→implementation matrix (every method → ported impl → future warehouse/SQL or self-hosted).
- **E11-S2** — the "adopt in a new app" config-only guide section.
- **E11-S3** — bar-A audit: paper design of a hypothetical second adapter + the null/second-mock swap against E10 with zero consumer edits.
- **E11-S4** — bar-B verification writeup driven off the E10 example (zero `packages/` edits).
- **E11-S5** — the automated vendor/product-name scan, wired as a CI-able (exit-nonzero) check.

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
