---
id: E16-S4-contract-docs
epic: E16-QRY-python-row-contract
status: ready-for-dev
area: query
touches: [node]
depends_on: [E16-S1-neutral-row-types]
api_impact: additive
---

# E16-S4-contract-docs — Document the Python row contract + cross-reference the parity artifact

## Why

A contract that isn't documented is the bug we're fixing. This slice documents the per-primitive row
shapes for Python consumers (snake_case) and confirms the Python docs match the TS docs conceptually.
The language-neutral parity artifact ALREADY EXISTS — this story cross-references it, it does not
rewrite it. It mirrors TS E15-S4 (minus writing the artifact, which E15 already shipped).

## Scope

### In

- Update the Python README query section (`python/README.md`) — the `### Query verbs → the query read
  client` table (~L157) and the intro sentence above it (~L159-162, which today ends "resolves the
  response synchronously … into one flat `QueryResult`"): the four structured primitives' cells today
  end "decodes to `QueryResult`" / "same POST + decode" (verified against the file) — change them to
  state **what each primitive's rows contain**, using the EXACT snake_case field names from
  `planning/QUERY-ROW-CONTRACT.md`:
  - `trend` / `unique_count` → rows of `{ bucket, value, breakdown? }`
  - `funnel` → rows of `{ step, event, count, conversion_rate, breakdown? }`
  - `retention` → rows of `{ cohort, period_index, value, breakdown? }`
  - `raw_query` → verbatim column-keyed pass-through (the default; the consumer's own SELECT
    projection — the one place a dialect-keyed shape legitimately surfaces)
  Do NOT rename any field (`conversion_rate` / `period_index` stay snake_case); this is the conformance
  surface Python consumers key on. Update the intro sentence if it still says the primitives merely
  "normalize … into one flat `QueryResult`" without mentioning the per-primitive rows.
- Also update the `### Query primitives — direct-analog` table (~L93) if it needs a note that the four
  structured primitives now return documented per-primitive neutral rows (the parity table that maps TS
  `uniqueCount` → Python `unique_count`, etc.) — keep it accurate to the shipped shape.
- **Cross-reference** `planning/QUERY-ROW-CONTRACT.md` as the language-neutral source of truth this
  Python surface satisfies, and cross-reference the S3 Python contract fixtures (S3 pins them at
  `python/tests/query_contract_fixtures.py`, mirroring the TS `query-contract.fixtures.ts`; confirm the
  final path against S3's Shipped notes before citing, since S3 permits a relocation) as the executable
  form of the Python-side contract — the analog of TS's fixtures cross-reference. Since S4 sequences
  AFTER S3, cite the real shipped path; do NOT invent one.
- Confirm the Python README query section matches the TS README query section CONCEPTUALLY — same row
  concepts, same `raw_query` verbatim-pass-through framing, only the casing differs (snake_case).

### Out

- Code + types + tests — S1/S2/S3.
- **Writing / editing `planning/QUERY-ROW-CONTRACT.md`** — it already exists (E15-S4) and is the shared
  source of truth BOTH trees satisfy; this story only cross-references it. Editing it would break the
  "parity by shared contract, not per-language re-authoring" discipline.
- Optional extras — deferred (epic Out of scope). The artifact already notes them as a planned additive
  extension; nothing to add here.

## Acceptance criteria

- [ ] The Python README query table states the concrete snake_case row shape for each of the five
      methods (`conversion_rate` / `period_index` snake_case, exact).
- [ ] The README cross-references `planning/QUERY-ROW-CONTRACT.md` as the parity source of truth and the
      S3 Python fixtures as the executable form.
- [ ] The Python README query section is conceptually consistent with the TS README query section (same
      row concepts, `raw_query` verbatim framing; only casing differs).
- [ ] Zero vendor/engine-internal field names in the README. `python/README.md` is covered by the
      Python neutrality-scan analog (`python/scripts/neutrality_scan.py`) — any leaked token there fails
      the gate; keep it clean.

## Technical notes

- **Docs-only story — no `src/` changes.** `api_impact` is additive (docs), even though the epic
  overall is breaking.
- **Field-name conformance is the whole point.** The README rows MUST use the exact snake_case field
  names from `planning/QUERY-ROW-CONTRACT.md` (`bucket`, `value`, `breakdown`, `step`, `event`,
  `count`, `conversion_rate`, `cohort`, `period_index`). Do NOT use the TS camelCase
  (`conversionRate`/`periodIndex`) in the Python docs — that casing is TS-only.
- **Sequencing (orchestrator): land S4 LAST, after S3.** S4 is only `depends_on: [E16-S1]` (it needs
  the frozen field names, which S1 provides), so it CAN start once S1 is in. But its cross-reference to
  the S3 Python fixtures dangles if S4 lands before S3 — sequence S4 after S3 so the reference resolves.
  If S4 must precede S3, phrase the fixtures reference as a forward pointer rather than citing a file
  the builder would have to invent. — mirrors the E15-S4 sequencing note.
- **Parity discipline.** The shipped TS seam + `planning/QUERY-ROW-CONTRACT.md` are the reference the
  Python port ports to; parity is by shared contract, not shared code. The artifact is that shared
  contract for the read side — this story confirms the Python docs express the SAME contract, cased
  idiomatically.

## Shipped

> Captured by `implement-epics` on 2026-07-13.

- **Files changed:** `python/README.md` — documented the per-primitive snake_case row shapes in the `### Query verbs → the query read client` matrix (each of the five methods states its row contents: `funnel` → `QueryResult[FunnelStepRow]` rows of `{ step, event, count, conversion_rate, breakdown? }`, `retention` → `{ cohort, period_index, value, breakdown? }`, `trend`/`unique_count` → `{ bucket, value, breakdown? }`, `raw_query` → default verbatim column-keyed pass-through) + its intro sentence + the `### Query primitives — direct-analog` parity table; added the two cross-references.
- **Files added:** none
- **New public API:** none — docs only. `api_impact: additive`.
- **Tests added:** none — docs only.
- **Commit:** `main` (message = story title)
- **Reviewer notes:** ship-ready, **no critical AND no suggestions** — a clean first review. Reviewer ground-truthed every claim against the shipped `client.py` dataclasses AND the S3 fixtures: funnel `conversion_rate` computed-relative-to-first-step, retention `period_index 0 = cohort`, `unique_count` its own named concept (not collapsed into trend), `raw_query` verbatim default — all backed by code line-for-line. Exact snake_case (grep confirmed no `conversionRate`/`periodIndex`); zero vendor tokens (both neutrality modes clean incl. `--full`). Both cross-references resolve (`../planning/QUERY-ROW-CONTRACT.md` as the parity source of truth both trees port to; `tests/query_contract_fixtures.py` as the executable form). Conceptually parity-consistent with the TS README (only casing + `[TRow]` vs `<TRow>` differ). The intra-doc anchor slug verified.
- **Retry history:** none — shipped first attempt.
- **Cross-story seams exposed:** none — this closes E16. The Python read side now documents the same neutral row contract as TS, cased idiomatically; `planning/QUERY-ROW-CONTRACT.md` remains the single shared source of truth both trees satisfy.
