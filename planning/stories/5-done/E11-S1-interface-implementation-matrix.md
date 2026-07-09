---
id: E11-S1-interface-implementation-matrix
epic: E11-CORE-adoption-audit
status: ready-for-dev
area: core
touches: [observability]
depends_on: [E11-S5-vendor-name-scan]
api_impact: additive
---

# E11-S1-interface-implementation-matrix — README interface→implementation matrix

## Why

Makes "a new adapter is fill-in-the-blanks" concrete: every neutral interface method mapped to its shipped (de-branded) implementation and the intended future warehouse/SQL or self-hosted cell — so a prospective adapter author sees exactly what to satisfy and a reader sees the seam is complete. This is the primary docs deliverable of the epic.

## Scope

### In

- A matrix section in the root `README.md` (the repo's single shipped doc surface — see Technical notes) with one row per neutral interface method:
  - **Client** (`AnalyticsProvider`, the frozen-15): `track`, `identify`, `page`, `group`, `reset`, `setTraits`, `register`, `unregister`, `optIn`, `optOut`, `hasOptedOut`, `flush`, `shutdown`, plus the `flags?` / `replay?` typed-extension-point ports (declared-only this release).
  - **Node** (`NodeAnalytics`): `capture`, `setTraits`, `setGroupTraits`.
  - **Query** (`AnalyticsQueryClient`): `funnel`, `retention`, `trend`, `uniqueCount`, `rawQuery`.
- Columns per row: **method → its shipped ported (de-branded) implementation, described BY ROLE and wire shape → the intended future warehouse/SQL or self-hosted implementation** (the "fill-in-the-blanks" cell).
- A note that the two extension-point ports (`flags?`/`replay?`) are declared-only by design (BRIEF §"Explicitly OUT this release") — the row states the seam exists, no impl ships.

### Out

- Building or changing any implementation — this is a docs/mapping deliverable only.
- The adopt-in-a-new-app narrative — that is E11-S2.
- The capability-completeness-vs-posthog-js coverage table — that is E11-S4's capability check; this matrix maps methods to impl cells, it does not argue completeness against the reference.

## Acceptance criteria

- [ ] Every frozen-15 client member, every node verb, and every query method has exactly one matrix row; the frozen-15 count (13 methods + `flags?` + `replay?`) is reflected exactly — no method omitted, none invented.
- [ ] Each implementation cell describes the shipped adapter BY ROLE and wire shape ("batch gzip POST to the configured ingest host", "HTTP query endpoint, Bearer personal key") — never by vendor name, and carries NO `$`-prefixed wire literal in prose.
- [ ] The matrix lives inside the vendor-name scan's coverage (S5) and PASSES it: zero `posthog`/`ph_`/hostname/`fernly`/`$`-literal matches in the README doc text.
- [ ] The future-impl cell is a real "fill-in-the-blanks" description (what a warehouse/SQL or self-hosted adapter must satisfy for that method), not a placeholder — grounded in the `WarehouseQueryAdapter` typed stub for the query rows and the `AnalyticsAdapter` SPI for the client rows.

## Technical notes

- Grounds against the SHIPPED surface: the frozen-15 is `packages/analytics-kit/src/analytics-provider.ts` (`AnalyticsProvider` — 13 methods + `flags?`/`replay?` = 15 members of `keyof AnalyticsProvider`; pin held every epic E6–E9). Node verbs: `packages/node/src/node-analytics.ts` (`NodeAnalytics`/`NodeCapture`). Query methods: `packages/node/src/query/query-client.ts` (`AnalyticsQueryClient`). Extension ports: `packages/analytics-kit/src/ports.ts` (`FeatureFlagPort`/`SessionReplayPort`, declared-only).
- **Docs land in the root `README.md`** (locked — see below). The repo ships exactly one root `README.md` (currently the intro + a "Usage (sketch)" block explicitly labelled illustrative — "API shown is illustrative and will change"); the matrix and the S2 adopt guide are sections appended to it. No `docs/` dir is introduced this release (a single shipped doc surface keeps the S5 scan's doc coverage trivial to reason about; revisit only if the README outgrows one file).
- **The existing README sketch does NOT define the matrix's surface — the shipped signatures do.** The current "Usage (sketch)" uses `analytics.capture(...)` and a `backend: { writeKey, endpoint }` config; NEITHER matches the real seam. The browser/root capture verb is `track` (`capture` is the node/adapter-level verb, `NodeAnalytics.capture` / `AnalyticsAdapter.capture`), and the real config is `AnalyticsConfig` (`key`, `ingestHost`/`ingestPath`, `allowlist`, `cookieDomain`/`crossSubdomainCookie`, `persistence`, `contexts`, …), NOT `backend.writeKey`/`endpoint`. Ground EVERY matrix row's method name and signature in the shipped source (below), not in the illustrative sketch — the matrix names `track`/`identify`/… as they actually are. If the builder finds the illustrative sketch's `capture`/`backend` shape directly contradicts the matrix rows on the same page, flag it (fixing the sketch is a README-prose change adjacent to this deliverable; do not silently leave a page that says both `track` and `capture` for the client verb without a note that the sketch is illustrative).
- **Describe-by-role constraint (from S5, architect-locked):** because shipped docs are INSIDE the vendor-name scan, every implementation cell names the adapter by role + wire shape, never by vendor; explicit posthog-js file:line citations stay in dev tooling (`planning/`, `CLAUDE.md`), which is exempt. This is why S1 `depends_on` S5 — the scan's confinement rule defines the writing constraint.
- **Executable-vs-prose:** this is PROSE docs (a mapping table is legitimately narrative), but it is gated indirectly — the S5 scan runs over the README, so the matrix cannot regress into vendor language without failing CI. The method-presence side is separately gated by S4's export-presence assertion.
- Bar-A grounding for the "future impl" column: the `AnalyticsAdapter` SPI (`packages/analytics-kit/src/adapter.ts`) is the client-side fill-in-the-blanks contract; the query-side `WarehouseQueryAdapter` typed stub (`packages/node/src/query/warehouse-query-adapter.ts`) is the concrete second-adapter proof that a query cell is genuinely fillable.

## Shipped
- > Reviewer suggestion (2026-07-09, improvement-pass): the Node table lists 3 of the 5 `NodeAnalytics` members — `flush()`/`shutdown()` are omitted (in-scope per the story, but the CLIENT table DOES include `flush`/`shutdown`, so a reader diffing the Node section vs `keyof NodeAnalytics` sees two real public lifecycle methods with no row). Add two Node rows (fill-in = the injected `SendBatch` delivery closure draining/quiescing) OR a one-line "Node's flush/shutdown share the client lifecycle semantics" note.
- > Reviewer note (2026-07-09, no change): the `rawQuery` "HTTP adapter's query dialect" phrasing is the CORRECT neutral abstraction (the dialect name is a vendor-adjacent query-language term deliberately kept in dev tooling, out of the README) — intentional, not an accuracy gap.

## Shipped

> Captured by `implement-epics` on 2026-07-09. The primary docs deliverable — the interface→implementation matrix (reviewer-verified row-accurate vs source).

- **Files changed:** `README.md` — appended the **Interface → implementation matrix** (Client / Node / Query tables) + corrected the pre-existing wrong "Usage (sketch)" (`analytics.capture(...)`+`backend:{writeKey,endpoint}` → real `track` root verb + `AnalyticsConfig` `key`/`ingestHost`; also fixed the Status line) so the page no longer self-contradicts the matrix.
- **New public API:** none — docs-only. NO impl changed.
- **The matrix (row-accurate, independently verified vs source):** Client = frozen-15 (`track`/`identify`/`page`/`group`/`reset`/`setTraits`/`register`/`unregister`/`optIn`/`optOut`/`hasOptedOut`/`flush`/`shutdown` = 13 methods + `flags?`/`replay?` ports = 15 members of `keyof AnalyticsProvider`; `context()` correctly EXCLUDED — it's on `RootAnalytics` not the frozen surface); Node = `capture`/`setTraits`/`setGroupTraits`; Query = `funnel`/`retention`/`trend`/`uniqueCount`/`rawQuery`. Columns: method → shipped de-branded impl BY ROLE + wire shape → future warehouse/SQL-or-self-hosted fill-in cell.
- **Neutrality (gated by S5, reviewer independently grep-verified clean):** every impl cell by-role+wire-shape ("gzipped batch POST to the configured ingest host/path", "HTTP query endpoint, Bearer personal key"), zero `posthog`/`ph_`/vendor-hostname/`$`-literal/bare-`fernly`; `pnpm neutrality-scan` PASSES (reads the real README). `flags?`/`replay?` rows state the seam exists + no impl ships (declared-only).
- **Future fill-in cells grounded (not placeholders):** client rows → the `AnalyticsAdapter` SPI method a self-hosted adapter must satisfy (`adapter.ts`); query rows → the `WarehouseQueryAdapter` typed-stub SQL mapping over the taxonomy-generated typed view.
- **Gates:** `pnpm neutrality-scan` PASS (15); build/test/typecheck/lint unaffected (docs-only), confirmed green.
- **Commit:** `E11-S1-interface-implementation-matrix — README interface→implementation matrix` on `core-cycle`
- **Reviewer notes:** ship-ready — 0 critical, 2 suggestions (Node flush/shutdown rows; rawQuery phrasing = no-change)
- **Cross-story seams exposed (S2):** the adopt guide lands in the SAME `README.md` inside the same S5 scan — describe-by-role/no-vendor/no-`$`-literal/`examples/fernly`-path-only apply verbatim (run `pnpm neutrality-scan` after). The real config surface to walk (from `AnalyticsConfig`, NOT the old sketch): `key`/`taxonomy`/`allowlist`/`onViolation`/`persistence`/`consentDefault`/`cookieDomain`/`crossSubdomainCookie`/session-timeouts/`ingestHost`/`ingestPath`/`botFilter`/flush-knobs/`compression`/`enrichment`/`autocapture`/`contexts`/`defaultContext`.

## Follow-up

> E11 post-close improvement pass, 2026-07-09 (commit follows). Reviewer-verified, scan PASS.

- **Node matrix rows completed** — added `flush()`/`shutdown()` rows to the README Node table (was 3 of the 5 `NodeAnalytics` members; the client table already had `flush`/`shutdown`, so a reader diffing vs `keyof NodeAnalytics` saw two real lifecycle methods with no row). Rows are by-role: `flush()` force-drains the in-memory queue via the injected delivery closure (stays usable); `shutdown()` drains + quiesces for process exit (timeout-raced). Neutral, no `$`-literal. `keyof NodeAnalytics` = 5, now fully covered. (Addresses the S1 Node-rows suggestion.)
