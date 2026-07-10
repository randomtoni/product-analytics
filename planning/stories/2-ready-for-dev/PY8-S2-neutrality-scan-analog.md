---
id: PY8-S2-neutrality-scan-analog
epic: PY8-OBS-parity-audit
status: ready-for-dev
area: observability
touches: [core, privacy]
depends_on: [PY8-S1-parity-matrix-and-readme]
api_impact: additive
---

# PY8-S2-neutrality-scan-analog — The Python neutrality-scan analog (`scripts/neutrality_scan.py`) as a standing gate

## Why

Stands up the **Python neutrality-scan analog** — the standing zero-vendor gate that is the whole
reason the library exists, ported from the TS capstone (`ts/scripts/neutrality-scan.ts`). It scans
the shipped artifacts (wheel + sdist) and the source tree (`ast` wire-confinement), exits nonzero on
any vendor leak, and is asserted by a `pytest` test. It is the Python realization of TS `E11-S5`
(the vendor-name scan). Depends on PY8-S1 because S1 finalizes the doc target(s) (`python/README.md` +
any linked parity doc) the scan's doc dimension must cover.

## Scope

### In

- **`python/scripts/neutrality_scan.py`** — a standalone script (NOT a ruff plugin, NOT raw grep;
  see Technical notes for why both are rejected) that classifies violations **by dimension** (what a
  consumer can observe) and exits nonzero on any violation. The dimensions, mapping the TS scan's
  dimensions onto Python:
  1. **wheel + sdist artifact scan** (the TS `declaration` + `js-bundle` + `package-name`/`file-name`
     dimensions collapsed onto Python's single shipped artifact) — builds the wheel + sdist
     (`uv build` / `python -m build`), **fully extracts BOTH**, and walks their **entire contents**:
     every `.py`/`.pyi` payload file (surface + runtime string-literal VALUES) AND the packaging
     metadata (`METADATA`, `PKG-INFO`, `RECORD`, any swept-in `.gitignore`/dotfiles) AND the
     distribution name + module paths — for the forbidden tokens. **This is the PY1-S1-escape fix
     (carry-in): scan the fully-extracted artifacts, not `src/`** — a `src/` grep missed vendor tokens
     that lived in wheel `METADATA` / sdist `PKG-INFO` / a swept-in root `.gitignore`.
  2. **`ast` wire-confinement pass over `python/src/analytics_kit/`** (the TS `wire-confinement`
     dimension) — parses every shipped `.py` with `ast`, PASSES a `$`-prefixed / wire string literal
     ONLY when it is the value of a module-level `_WIRE_*`-named constant inside an adapter submodule,
     and FAILS it anywhere else (an escaped-confinement leak). A new adapter's wire token passes the
     SAME gate with zero scan edits iff it obeys the `_WIRE_*` convention.
  3. **doc dimension** — scans the shipped doc(s) finalized by PY8-S1 (`python/README.md` + any linked
     parity doc) for the forbidden tokens, with the ONE product-name path carve-out (a bare
     `examples/quillstream` path link allowed; bare-prose `quillstream` fails), exactly as the TS scan
     carves out `examples/fernly`.
- **`FORBIDDEN_TOKENS`** mirroring the TS scan's SEMANTICS (see Technical notes — this is load-bearing):
  bans vendor/product NAMES — `posthog` (case-insensitive), `ph_`, vendor region hostnames
  (`i.posthog.com`, `us.i.`, `eu.i.`), and the invented product name `quillstream` (outside its
  `examples/` path) — and PERMITS the confined wire vocabulary. **`hogql`/`HogQLQuery` is NOT a
  forbidden token** — it is REQUIRED confined wire vocabulary (carry-in #3): do NOT write a rule or an
  AC that greps `hogql` to zero.
- **The provenance-comment exemption, explicit and by-construction.** The `ast` pass never sees `#`
  comments, so `# De-branded from posthog's …` provenance comments are AST-exempt by construction (no
  comment-stripping step needed). **The epic PM-locks that these comments MAY reach the shipped wheel**
  (Python ships source; they can't be stripped without a build step) — a deliberate, documented
  divergence from TS (which strips them from `dist`). Lock the boundary PRECISELY (carry-in #2):
  **`#` comments are exempt; docstrings and packaging metadata are NOT** — docstrings ship as source in
  the wheel and are scanned; a vendor token in a docstring or in `METADATA`/`PKG-INFO` FAILS.
- **A `pytest` test** (`python/tests/test_neutrality_scan.py`) that runs the scan over the real tree and
  asserts **zero violations** (a failing assertion = a nonzero pytest exit = the gate tripping), PLUS
  **planted-violation tests** proving each dimension actually catches a leak (a `posthog` token planted
  in a synthetic wheel-metadata / `.py` payload / docstring; a `$`-literal escaped from a `_WIRE_*`
  const; a bare-prose `quillstream` in a synthetic doc) and **pass tests** proving the legitimate cases
  don't false-fail (a confined `$`-literal inside a `_WIRE_*` const; a `# De-branded from posthog's …`
  comment; the required `hogql`/`HogQLQuery` wire vocabulary; an `examples/quillstream` path link).

### Out

- The parity matrix + README docs — **PY8-S1** (this story's doc dimension SCANS them; S1 writes them).
- The real-stack probes + negative controls + bar-A/bar-B proofs — **PY8-S3**.
- **Wiring the wheel scan into the every-commit inner loop** — PM-locked (epic `## Notes`): the `src/`
  `ast` pass runs on every commit; the **wheel/sdist scan is CI-only** (building the wheel per commit is
  too slow for the inner loop). The script supports both modes; the story wires the src-`ast` pass into
  the fast gate and documents the wheel scan as the CI step.
- A CI pipeline itself — the gate runs locally via `uv`/`pytest`; CI-wiring is later infra.
- `python/examples/**` — scan-EXEMPT (carry-in #4; consumer territory — the scan targets the LIBRARY
  `src/analytics_kit/` + its built artifacts only), exactly as the TS scan exempts `examples/**`.

## Acceptance criteria

- [ ] `python/scripts/neutrality_scan.py` exists, classifies by dimension, and exits nonzero on any
      violation. It is a standalone script, NOT a ruff plugin, NOT a raw grep.
- [ ] The artifact dimension builds AND fully extracts the wheel + sdist and walks their **entire
      contents** — every `.py`/`.pyi` payload AND the packaging metadata (`METADATA`/`PKG-INFO`/`RECORD`/
      swept-in dotfiles) AND the distribution + module names — for the forbidden tokens. A vendor token
      in wheel `METADATA` or sdist `PKG-INFO` FAILS (the PY1-S1-escape regression is covered by a planted
      test).
- [ ] The `ast` wire-confinement pass over `python/src/analytics_kit/` PASSES a `$`-prefixed / wire
      literal ONLY as the value of a module-level `_WIRE_*` const and FAILS it anywhere else. A planted
      escaped `$`-literal fails; the real `_WIRE_*` consts in `server/wire_mapper.py` (and any query-adapter
      `_WIRE_*` consts) pass. A NEW `_WIRE_*`-obeying adapter const passes with zero scan edits.
- [ ] `FORBIDDEN_TOKENS` bans vendor/product NAMES only (`posthog`/`ph_`/hostnames/`quillstream`-outside-
      `examples/`) and does NOT ban the confined wire vocabulary. **`hogql`/`HogQLQuery` PASSES** (it is
      required confined wire vocab) — there is NO AC and NO rule that greps `hogql` to zero.
- [ ] Provenance-comment boundary is exact: a `# De-branded from posthog's …` comment PASSES (AST-exempt
      by construction, MAY reach the wheel per the PM-lock); a vendor token in a **docstring** or in wheel
      **`METADATA`/`PKG-INFO`** FAILS (docstrings + metadata are NOT exempt). Both cases are covered by
      tests.
- [ ] The doc dimension scans the PY8-S1 doc target(s); a bare-prose vendor/product token FAILS; a bare
      `examples/quillstream` path link PASSES (the one carve-out, mirroring TS `examples/fernly`).
- [ ] `python/tests/test_neutrality_scan.py` asserts ZERO violations over the real tree AND includes
      planted-violation tests (one per dimension) + false-fail-guard pass tests. `uv run pytest` +
      `uv run ruff check` + `uv run mypy` stay green.
- [ ] The scan self-scan gotcha is handled structurally: `scripts/neutrality_scan.py` NAMES the forbidden
      tokens as its own match patterns, so it must be EXCLUDED from its own scan by construction (anchored
      to `src/analytics_kit/` + the built artifacts + the doc paths; `scripts/` is under none of them) —
      mirror the TS scan's self-scan handling.

## Technical notes

- **#4 ARCHITECT RULING (epic `## Notes`, 2026-07-09, Cluster 4, high) — targets + mechanism.** Python
  has no tsup/dist — the shipped artifact is the **wheel/sdist** (payload ≈ `src/` + metadata). Map the
  TS scan's dimensions: declaration/js-bundle → scan the wheel's `.py`/`.pyi` for forbidden tokens +
  string-literal values; wire-confinement → `ast` pass over `src/` passing `$`-literals only under
  `_WIRE_*` module-level constants (the exact TS `WIRE_CONST_NAME` convention); package/file-name →
  distribution name + module paths; doc → README/prose (no exemption). A **standalone script asserted by
  pytest**, NOT a ruff plugin (ruff can't scan the built wheel) and NOT raw grep (false-fails on
  provenance comments + confined `$`-literals — the exact reasoning the TS scan's header comment documents).
- **Carry-in #1 (from PY7) — scan the FULLY-EXTRACTED wheel + sdist, not just `src/`.** The PY1-S1 escape
  was vendor tokens in wheel `METADATA` / sdist `PKG-INFO` / a swept-in root `.gitignore` that a clean
  `src/` grep missed. The artifact dimension MUST `uv build` (or `python -m build`), extract BOTH the
  `.whl` (a zip) and the `.tar.gz` sdist, and walk their FULL contents — metadata AND payload — not
  assume `src/` ≈ wheel. Cover this with a planted test (a synthetic wheel/metadata carrying a vendor
  token must FAIL).
- **Carry-in #2 (from PY7) — comments exempt, docstrings + metadata NOT.** The `ast` pass never visits
  `#` comments, so `# De-branded from posthog's …` provenance is exempt by construction — and the epic
  PM-locks that these comments MAY reach the wheel (Python ships source; a documented divergence from TS,
  which strips them from `dist`). BUT docstrings ship as source in the wheel `.py` files, and packaging
  metadata ships in `METADATA`/`PKG-INFO` — a vendor token in EITHER must FAIL. Lock this precisely: the
  ONLY AST-exempt category is `#` comments; docstrings and metadata are in-scope and scanned.
- **Carry-in #3 (architect-ratified in PY5) — mirror TS `FORBIDDEN_TOKENS` semantics, not a naive
  `posthog` grep.** The scan bans vendor NAMES (`posthog`/`ph_`/hostnames/`quillstream`-outside-examples)
  and PERMITS the confined wire vocabulary. **`hogql`/`HogQLQuery` is REQUIRED confined wire vocabulary**
  — it lives in a `_WIRE_*` module-level constant in the query adapter (`query/http_adapter.py`; read it
  to confirm the exact const name) — it is NOT a forbidden token. Do NOT write an AC or a rule that greps
  `hogql` to zero — that is unsatisfiable (a PY5 story shipped this bug). The correct gate is
  **vendor-name-only**; the `_WIRE_*` confinement is what proves the wire vocab stays contained, NOT a
  token ban on it.
- **Carry-in #4 (from PY7) — `python/examples/**` is scan-EXEMPT.** The neutrality scan targets the
  LIBRARY (`src/analytics_kit/` + its built artifacts) only. `examples/` (Quillstream) is consumer
  territory and may freely name its invented product — exactly as the TS scan exempts `examples/**`.
- **`_WIRE_*` confinement — the exact convention.** Read `server/wire_mapper.py`: every wire token is a
  module-level `_WIRE_*_KEY` constant (`_WIRE_UUID_KEY = "uuid"`, `_WIRE_SET_KEY = "set"`,
  `_WIRE_GROUP_TYPE_KEY`, `_WIRE_API_KEY`, `_WIRE_BATCH_KEY`, `_WIRE_SENT_AT_KEY`, …). The `ast` pass
  visits `ast.Assign`/`ast.AnnAssign` nodes and passes a `$`-prefixed (or otherwise wire-shaped) string
  literal ONLY when its target is a module-level `Name` matching `_WIRE_*`. NOTE: the Python server wire
  tokens are mostly NOT `$`-prefixed (`"uuid"`, `"event"`, `"set"` — de-branded, no `$`). The `$`-anchored
  arm (mirroring TS) catches any `$`-literal that leaks in; the confinement RULE (a `_WIRE_*` const holds
  the wire token) is the general invariant. Confirm with the architect/`posthog-source-guide` whether any
  shipped Python wire literal is `$`-prefixed (browser-only `$`-props should be absent server-side — the
  server uses `uuid`, not `$insert_id`); if none are, the `$`-arm is a forward-consistency guard (like the
  TS `_WIRE_KIND` widening) and the primary confinement gate is the `_WIRE_*`-const rule over the query
  dialect vocabulary (`HogQLQuery` et al.).
- **The self-scan gotcha (TS-locked, port it).** `scripts/neutrality_scan.py` names the forbidden tokens
  as its own patterns, so it self-fails if scanned. Anchor every dimension to `src/analytics_kit/` + the
  built artifacts + the doc paths — `scripts/` is under none of them — so the script is excluded from its
  own scan by construction. Mirror the TS scan's `SELF-SCAN gotcha` comment.
- **Inner-loop vs CI split (PM-locked, epic `## Notes`).** The `src/` `ast` pass is cheap → runs on every
  commit (wire into the fast `uv run pytest` gate). The wheel/sdist scan needs a build → CI-only (no
  `python -m build` per commit). The script exposes both as callable entry points; document the two
  invocations (fast: the `ast` + doc pytest gate; CI: the full build-extract-scan) in the Shipped note so
  the orchestrator + reviewer know how to run each.
- **CONTRACT reference (port TO):** `ts/scripts/neutrality-scan.ts` + `ts/scripts/neutrality-scan.test.ts`
  — the exact dimensions (declaration/js-bundle → wheel `.py`/`.pyi` + metadata; wire-confinement → `ast`
  over `src/`; package/file-name → dist name + module paths; doc → README with the ONE product-path
  carve-out), the confinement-rule-not-whitelist invariant, the comment-exempt-by-parsing logic, the
  planted-violation + false-fail-guard test structure, and the self-scan handling. De-brand nothing; port
  the dimensions and the reasoning. Ground "how the wheel/sdist is laid out + what metadata files ship"
  in `python/pyproject.toml` (hatchling; `[tool.hatch.build.targets.wheel] packages = ["src/analytics_kit"]`
  + `[tool.hatch.build.targets.sdist] only-include = [...]`).

## Shipped
