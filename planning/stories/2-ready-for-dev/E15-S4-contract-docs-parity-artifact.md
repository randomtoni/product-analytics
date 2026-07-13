---
id: E15-S4-contract-docs-parity-artifact
epic: E15-QRY-response-row-contract
status: ready-for-dev
area: query
touches: [node]
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

- Update the TS README query table (`ts/README.md`, the table around line 157): each primitive row
  currently only says "normalizes into `QueryResult`" — change it to state **what each primitive's rows
  contain** (`trend`/`uniqueCount` → `{ bucket, value, breakdown? }`; `funnel` →
  `{ step, event, count, conversionRate, breakdown? }`; `retention` →
  `{ cohort, periodIndex, value, breakdown? }`; `rawQuery` → verbatim column-keyed pass-through).
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
- [ ] Zero vendor/engine-internal field names in either doc; neutrality scan green (README is scanned).

## Technical notes

- This is a planning-doc + README-docs story — no `src/` changes. `api_impact` is additive (docs), even
  though the epic overall is breaking.
- Parity discipline mirrors the Python-parity cycle precedent: the shipped TS seam is the reference the
  Python port ports to; parity is by shared contract, not shared code. The artifact is that shared
  contract for the read side. — from HISTORY (`Python parity` cycle) + architect (2026-07-13)
