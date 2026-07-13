---
id: E15-S4-contract-docs-parity-artifact
epic: E15-QRY-response-row-contract
status: ready-for-dev
area: query
touches: [query]
depends_on: [E15-S1-neutral-row-types]
api_impact: additive
---

# E15-S4-contract-docs-parity-artifact — Document the row contract + write the parity artifact

## Why

A contract that isn't documented is the bug we're fixing. This slice documents the per-primitive row
shapes for TS consumers and writes the language-neutral contract artifact the Python query client will
port to (parity by shared contract, not shared code).

## Scope

### In

- Update the TS README query table under the **`### Query — AnalyticsQueryClient (KPI primitives)`** heading
  (`ts/README.md`, the 5-row table ~line 157; locate by heading, the line shifts): each row's "Shipped
  implementation" cell currently ends "normalizes the response into `QueryResult`" — change it to state
  **what each primitive's rows contain**, using the EXACT S1 field names (camelCase, no drift):
  `trend`/`uniqueCount` → `QueryResult<{ bucket, value, breakdown? }>`; `funnel` →
  `QueryResult<{ step, event, count, conversionRate, breakdown? }>`; `retention` →
  `QueryResult<{ cohort, periodIndex, value, breakdown? }>`; `rawQuery` → verbatim column-keyed
  pass-through (`QueryResult<Record<string, unknown>>` — the default). Do NOT rename any field
  (`conversionRate`/`periodIndex` stay camelCase); this is the conformance surface consumers key on.
  Also update the intro sentence above the table (~line 151-155) if it still says primitives "normalize
  the wire envelope into the neutral `QueryResult`" without mentioning the per-primitive rows — add that the
  four structured primitives now return documented per-primitive neutral rows.
- Write a **language-neutral contract artifact** under `planning/` (e.g.
  `planning/QUERY-ROW-CONTRACT.md`) stating the per-primitive field set as the shared contract both
  language trees satisfy. Field concepts: `bucket`, `value`, `breakdown`, `step`, `event`, `count`,
  `conversionRate`, `cohort`, `periodIndex` — noting each language cases idiomatically (TS camelCase,
  Python snake_case). Mark it as the source of truth the Python query client ports TO.
- Cross-reference the S3 fixtures as the executable form of the contract.

### Out

- Code + types + tests — S1/S2/S3.
- The Python implementation itself — the Python query cycle (this only writes the contract it ports to).
- Optional extras — deferred (epic Out of scope), but the artifact may note them as a planned additive
  extension so the Python port knows they're coming.

## Acceptance criteria

- [ ] The TS README query table states the concrete row shape for each of the five methods.
- [ ] `planning/QUERY-ROW-CONTRACT.md` exists, states the neutral field set per primitive, and is marked
      as the parity source of truth (TS camelCase / Python snake_case noted).
- [ ] The artifact references the S3 contract fixtures.
- [ ] Zero vendor/engine-internal field names in either doc. `ts/README.md` is scanned by the neutrality
      gate (`neutrality-scan.test.ts` sets `readmePath = ts/README.md`) so any leaked token there fails the
      gate. `planning/QUERY-ROW-CONTRACT.md` is NOT in the scan surface (planning/ is dev-facing, same class
      as `CLAUDE.md` — the scan only covers `packages/**` + `ts/README.md`); keep it vendor-clean BY HAND —
      the reviewer is the backstop, not the scan.

## Technical notes

- This is a planning-doc + README-docs story — no `src/` changes. `api_impact` is additive (docs), even
  though the epic overall is breaking.
- **Sequencing (orchestrator): land S4 LAST, after S3.** S4 is only `depends_on: [E15-S1]` (it needs the
  frozen field names, which S1 provides), so it CAN start once S1 is in. But its Scope.In cross-references
  the S3 wire→neutral-row fixtures as "the executable form of the contract" — if S4 lands before S3, that
  reference dangles. Recommend the orchestrator sequence S4 after S3 so the fixture cross-reference resolves
  to real files. If S4 must land before S3 for scheduling reasons, phrase the cross-reference as a forward
  pointer ("the per-primitive contract fixtures in `http-query-adapter.test.ts`") rather than citing a
  specific fixture the builder would have to invent. — story-refiner (2026-07-13)
- **Field-name conformance is the whole point of this story.** The README rows + the parity artifact MUST
  use S1's exact camelCase field names (`bucket`, `value`, `breakdown`, `step`, `event`, `count`,
  `conversionRate`, `cohort`, `periodIndex`). The parity artifact additionally states the Python snake_case
  casing (`conversion_rate`, `period_index`, ...) as the idiomatic port target — that snake_case appears
  ONLY in the parity artifact's "Python cases as" column, never in the TS README. — architect (2026-07-13)
- Parity discipline mirrors the Python-parity cycle precedent: the shipped TS seam is the reference the
  Python port ports to; parity is by shared contract, not shared code. The artifact is that shared
  contract for the read side. — from HISTORY (`Python parity` cycle) + architect (2026-07-13)
