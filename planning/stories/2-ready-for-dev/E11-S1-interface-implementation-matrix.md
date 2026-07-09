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
- **Docs land in the root `README.md`** (locked — see below). The repo ships exactly one root `README.md` (currently the minimal intro + usage sketch); the matrix and the S2 adopt guide are sections appended to it. No `docs/` dir is introduced this release (a single shipped doc surface keeps the S5 scan's doc coverage trivial to reason about; revisit only if the README outgrows one file).
- **Describe-by-role constraint (from S5, architect-locked):** because shipped docs are INSIDE the vendor-name scan, every implementation cell names the adapter by role + wire shape, never by vendor; explicit posthog-js file:line citations stay in dev tooling (`planning/`, `CLAUDE.md`), which is exempt. This is why S1 `depends_on` S5 — the scan's confinement rule defines the writing constraint.
- **Executable-vs-prose:** this is PROSE docs (a mapping table is legitimately narrative), but it is gated indirectly — the S5 scan runs over the README, so the matrix cannot regress into vendor language without failing CI. The method-presence side is separately gated by S4's export-presence assertion.
- Bar-A grounding for the "future impl" column: the `AnalyticsAdapter` SPI (`packages/analytics-kit/src/adapter.ts`) is the client-side fill-in-the-blanks contract; the query-side `WarehouseQueryAdapter` typed stub (`packages/node/src/query/warehouse-query-adapter.ts`) is the concrete second-adapter proof that a query cell is genuinely fillable.

## Shipped
