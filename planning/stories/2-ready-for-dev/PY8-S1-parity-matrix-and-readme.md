---
id: PY8-S1-parity-matrix-and-readme
epic: PY8-OBS-parity-audit
status: ready-for-dev
area: observability
touches: [core, node]
depends_on: []
api_impact: additive
---

# PY8-S1-parity-matrix-and-readme — Capability-parity matrix vs the TS surface + README interface→implementation + adopt-in-a-new-app

## Why

The capstone's first slice: prove the Python port is at **capability parity with the TS surface
with no silent gap** by writing the parity matrix — every TS capability ruled
direct-analog / idiomatic-adaptation / **N-A-by-platform** / **declared-but-unimplemented slot**.
This is the Python realization of TS `E11-S1` (interface→implementation matrix) + `E11-S2`
(adopt-in-a-new-app guide). It is the audit's documentation deliverable; PY8-S2 (the scan) and
PY8-S3 (the probes) are the enforcement deliverables built alongside.

## Scope

### In

- A **capability-parity matrix** (a Markdown table in **`python/README.md`** — see the doc-target pin in
  Technical notes: the matrix goes IN `python/README.md`, NOT a forked `python/PARITY.md`, so the
  neutrality scan's single doc dimension covers it with zero `extra_doc_paths` coordination) mapping
  **every TS surface capability** to its Python disposition, one of four categories, each row explicit —
  **no silent gap**:
  1. **direct-analog** — same verb, same shape (`track`→`capture`, `flush`, `shutdown`, `optIn`/`optOut`/`hasOptedOut`→`opt_in`/`opt_out`/`has_opted_out`, the query primitives `funnel`/`retention`/`trend`/`unique_count`/`raw_query`).
  2. **idiomatic-adaptation** — the same capability, server-shaped (`identify`+`setTraits`→`set(...)` — two facade members collapse to one; `group`→`set_group_traits`; `register`→construction-time `super_properties` dict).
  3. **N-A-by-platform** — browser-only, by-design server-shaped omissions (see the exact row list below).
  4. **declared-but-unimplemented slot** — `flags?` (`FeatureFlagPort`) and `replay?` (`SessionReplayPort`): the Python seam DECLARES both optional `Protocol` slots (`ports.py`, `None`-default on the provider) exactly as TS declares them `undefined`-in-R1 — parity-PRESENT-as-slots rows, **a distinct category from N-A-by-platform**.
- The matrix's **N-A-by-platform rows**, each named explicitly as a by-design server-shaped omission (NOT a gap):
  `page` (no server pageview surface), `reset` (no persisted server identity to re-anonymize),
  runtime `register`/`unregister` (no runtime super-property store server-side — `register` maps to
  construction-time `super_properties`, `unregister` has no analog), browser persistence
  (cookie/localStorage), autocapture, pageviews, cross-subdomain cookies, `sendBeacon`/unload,
  the anonymous→identified merge, the browser transport, and the browser-only reserved-event-name /
  `__ak_` persistence-key prefix mechanisms (empty reserved set + no `__ak_` prefix server-side).
- The **two declared-slot rows** (`flags?`/`replay?`) called out as their own category, with `replay`
  noted as browser-shaped-in-practice AND a declared slot, and `flags` as the declared slot the
  UPCOMING feature-flags cycle will fill server-side.
- The **taxonomy compile-time-guarantee-gap statement**: Python provides runtime-registry parity +
  best-effort static typing, **NOT TS-parity** (TS compile-time literal typing). This is PY3's
  PM-locked promise — state it as an explicit matrix row/note, not a silent difference.
- A **README interface→implementation matrix** (mirroring TS `E11-S1`): for every provider verb
  (`capture`, `set`, `set_group_traits`, `opt_in`/`opt_out`/`has_opted_out`, `flush`, `shutdown`) +
  query verb (`funnel`, `retention`, `trend`, `unique_count`, `raw_query`), a row mapping
  **method → its shipped de-branded implementation (described by role/wire shape, never by vendor) →
  the intended future warehouse/self-hosted implementation cell**, so a new adapter is genuinely
  fill-in-the-blanks.
- A README **"Adopt in a new app" config-only section** (mirroring TS `E11-S2`): walks a new consumer
  through adoption via config + the taxonomy/allowlist surface alone (key, `super_properties`,
  allowlist contents, `on_violation`, taxonomy, query endpoint/key, framework wiring) — each lever
  as consumer-supplies-vs-library-owns, grounded in the Quillstream example (`python/examples/quillstream/`),
  zero `analytics_kit` edits.

### Out

- The neutrality-scan analog — **PY8-S2**.
- The real-stack probes + negative controls + re-runnable bar-A/bar-B gated proofs — **PY8-S3**.
- **Fixing** any capability gap the matrix surfaces — a real (non-N-A) gap is a bug/story against the
  owning epic, NOT audit scope. The matrix's job is to SURFACE gaps, never paper them.
- Any `analytics_kit` src/tests edit — this story writes docs only (`python/README.md` — the single
  pinned doc target; no forked parity doc). No library code changes.

## Acceptance criteria

- [ ] Every TS surface capability appears in the parity matrix under exactly one of the four
      categories (direct-analog / idiomatic-adaptation / N-A-by-platform / declared-but-unimplemented
      slot). The Frozen-15 facade accounting in `provider.py`'s module docstring is the source of
      truth for the 15 client-facade rows — the matrix must not contradict it.
- [ ] The N-A-by-platform rows are all present and each labelled a **by-design server-shaped
      omission** (not a gap): `page`, `reset`, runtime `register`/`unregister`, browser persistence,
      autocapture, pageviews, cross-subdomain cookies, `sendBeacon`/unload, anon→identified merge,
      browser transport, empty reserved-event set + no `__ak_` prefix.
- [ ] `flags?` and `replay?` are in their OWN **declared-but-unimplemented slot** category (NOT the
      N-A rows), matching the TS-E11 flags/replay by-design-omitted-slot precedent, and grounded in the
      real `FeatureFlagPort`/`SessionReplayPort` `Protocol`s in `ports.py` + the `None`-default
      `flags`/`replay` attributes on `Analytics`.
- [ ] The taxonomy compile-time-guarantee-gap row is present and states the Python =
      runtime-registry-parity + best-effort-static, NOT TS-parity difference (PY3's PM-locked gap).
- [ ] A README interface→implementation matrix maps every provider + query verb to its de-branded
      implementation (by role/wire shape, no vendor name) + a future warehouse/self-hosted cell.
- [ ] A README "Adopt in a new app" config-only section walks every lever, grounded in the Quillstream
      example, stating the zero-`analytics_kit`-edits (bar-B) invariant.
- [ ] Every implementation/lever is described by **role and wire shape**, never by vendor name — the
      doc must pass the PY8-S2 neutrality scan's doc dimension (no `posthog`/`ph_`/hostname/`quillstream`
      in prose; a bare `examples/quillstream` path link is the only allowed product-name form). The
      confined wire vocabulary (`hogql`/`HogQLQuery`) is NOT a doc concern here (it never appears in
      prose) — do not invent a rule that bans it.

## Technical notes

- **The Frozen-15 accounting is the parity-matrix spine — copy it, do not re-derive it.** `provider.py`'s
  module docstring already enumerates all fifteen reference-facade members with their exact server
  disposition (nine mapped verbs, four N-A-by-platform — `page`/`reset`/`register`/`unregister` —, two
  `None` capability slots — `flags`/`replay`). The parity matrix's client-facade rows ARE that table,
  re-expressed for a consumer audience. Read it verbatim; any divergence between the matrix and that
  docstring is a bug in the matrix.
- **Two distinct categories, not one (epic `## Notes`, PM-locked).** N-A-by-platform ("server has no
  analog — browser-only mechanism") and declared-but-unimplemented-slot ("declared, awaiting the owning
  cycle") are SEPARATE matrix categories. `flags?`/`replay?` are declared slots (parity-present-as-slots),
  NOT N-A rows — a reader must be able to tell the two apart. This mirrors TS-E11's by-design-omitted-slot
  flags/replay rows vs its browser-N-A rows.
- **Server-side-N-A row source of truth.** The browser-only surface that is N-A server-side:
  persistence (cookie/localStorage), autocapture, pageviews, cross-subdomain cookies, `sendBeacon`/unload,
  the anon→identified merge, runtime `register`/`unregister`, the browser transport, AND (carry-in from
  PY7) the empty reserved-event-name set + no `__ak_` persistence-key prefix (both browser-only mechanisms
  with no server home) + capture-only prop validation (server validates props at capture, has no
  browser-style set/group trait-shape validation — see `provider.capture`'s comment). Each is a documented
  omission row, no silent gap.
- **Taxonomy-gap statement (PY3 PM-lock).** Python taxonomy = a runtime registry (`define_taxonomy` /
  `derive_allowlist_from_taxonomy` / `validate_event_props`) + best-effort static typing, NOT the TS
  compile-time literal-union guarantee. State this as an explicit row: "compile-time event-name/prop
  typing — TS: yes (literal unions); Python: best-effort static + runtime validation (PY3 PM-locked gap)."
- **Describe by role/wire shape, never by vendor (E11-S1/S2 lock, carried).** The implementation cells
  say "batch POST to the configured ingest host, `{api_key, batch, sent_at}` envelope", "HTTP query
  endpoint, Bearer key" — never a vendor name. The doc lives INSIDE the PY8-S2 scan's doc dimension, so a
  vendor token in prose fails the gate. Explicit posthog-python file:line references, if any are useful for
  provenance, belong in dev tooling (`planning/`, `CLAUDE.md`) which the scan exempts — not in the shipped
  README.
- **Query surface for the interface matrix.** The five query primitives are `funnel`/`retention`/`trend`/
  `unique_count`/`raw_query` on `AnalyticsQueryClient` (`query/client.py`); their specs are `FunnelSpec`/
  `RetentionSpec`/`TrendSpec`/`UniqueCountSpec`, each returning a flat `QueryResult`. `raw_query` is the ONE
  dialect escape hatch and surfaces the dialect as a VALUE (a string), never a type.
- **Docs shape (pin — DECIDED, verified against the real tree).** Verified state: `python/README.md`
  EXISTS as a thin scaffold (sections: title / `## Toolchain` / `## Layout` — ~1.2 KB); there is **NO
  `python/PARITY.md`**; and PY7-S3's bar-B two-gate note lives in the **Quillstream** README
  (`python/examples/quillstream/README.md`), NOT in `python/README.md`. **DECISION (pinned, not the
  builder's call): the parity matrix + interface→implementation matrix + adopt-in-a-new-app section all go
  IN `python/README.md`. Do NOT fork a `python/PARITY.md`.** Rationale: one doc target keeps PY8-S2's doc
  dimension a single path with zero `extra_doc_paths` coordination — S2 scans exactly `python/README.md`
  (S2's doc-dimension AC is written against this one file). This is a hard coordination pin, not a
  preference; if the builder finds a compelling reason to split, that is an Open Question to surface, not a
  silent divergence — because S2's scan target depends on it. (The Quillstream README stays as PY7 left it
  and is scan-EXEMPT under `examples/**`; do not touch it.)
- **CONTRACT reference (port TO):** TS `E11-S1` (`planning/stories/5-done/E11-S1-interface-implementation-matrix.md`)
  + `E11-S2` (`E11-S2-adopt-in-new-app-guide.md`) — the 15-client + 3-node + 5-query interface matrix, the
  by-role/wire-shape description discipline, the config-only adoption walk, and the by-design-omitted
  flags/replay rows. Port the shape; server-shaped (no browser persistence/JSX rows — those become N-A
  rows here). The TS matrix's node rows (`capture`/`setTraits`/`setGroupTraits`) map onto the Python
  provider's `capture`/`set`/`set_group_traits` — Python's provider IS server-shaped, so there is no
  separate browser-vs-node split to reconcile.

## Shipped
