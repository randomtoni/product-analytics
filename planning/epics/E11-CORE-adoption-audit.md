---
id: E11-CORE-adoption-audit
status: active
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

Five stories in `stories/2-ready-for-dev/`. **S5 (the vendor-name scan) ships first** — its confinement rule (describe-by-role, never by vendor) constrains what the docs stories may write, so S1/S2 depend on it. S3/S4 are independent acceptance sweeps grounded in already-shipped surfaces (E8 / E10).

- **[E11-S5](../stories/2-ready-for-dev/E11-S5-vendor-name-scan.md)** *(additive, no deps)* — GATED CHECK: CI-able exit-nonzero vendor/product-name scan over the library SURFACE (scan-by-dimension against built `.d.ts`, not raw grep). `$`-wire literals gated by a `_WIRE_`-confinement rule (not a whitelist); port-citation comments + `[WIRE]` literals correctly pass. `packages/**`-anchored, `examples/**`/`planning/**`/`fernly` exempt.
- **[E11-S1](../stories/2-ready-for-dev/E11-S1-interface-implementation-matrix.md)** *(additive, depends on S5)* — PROSE docs (README): interface→implementation matrix — every frozen-15 client verb + 3 node verbs + 5 query methods → shipped ported impl (by role/wire shape) → future warehouse/SQL or self-hosted cell. Lives inside the S5 scan.
- **[E11-S2](../stories/2-ready-for-dev/E11-S2-adopt-in-new-app-guide.md)** *(additive, depends on S5)* — PROSE docs (README): "adopt in a new app" config-only guide walking every config/generics lever (taxonomy, identity mapping, cookie domain, contexts/profiles, allowlist, KPI defs, framework wiring), seeded by E10 Fernly. Lives inside the S5 scan.
- **[E11-S3](../stories/2-ready-for-dev/E11-S3-bar-a-adapter-swap-audit.md)** *(additive, no deps)* — GATED swap + PROSE design: bar A (provider-swap = one adapter, zero consumer change) — the concrete `NoopAdapter`↔`RecordingAdapter` swap through the E10 Fernly harness (zero consumer edits) + on-paper second-adapter design over the `AnalyticsAdapter` SPI, citing the E8 `WarehouseQueryAdapter` proof.
- **[E11-S4](../stories/2-ready-for-dev/E11-S4-bar-b-and-capability-completeness.md)** *(additive, no deps)* — GATED checks + PROSE table: bar B (new-app adoption = config only — E10 Fernly, zero `packages/**`) + capability-completeness (prose coverage table vs posthog-js scoped to the BRIEF contract, incl. by-design-omitted flags/replay rows; gated frozen-15 + query export/type-presence assertion over `dist`).

Dependency graph (topo-sortable): **S5 → {S1, S2}**; **S3** and **S4** independent (no deps). A valid order: S5 → S1 → S2 → S3 → S4 (S3/S4 may run any time).

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
