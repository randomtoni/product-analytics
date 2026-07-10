---
id: PY8-OBS-parity-audit
status: planned
area: observability
touches: [core, privacy]
api_impact: additive
blocked_by: [PY7-CORE-example-consumer]
updated: 2026-07-09
---

# PY8-OBS-parity-audit — Python parity audit + neutrality gate

## Why

The capstone: prove the Python port is at **capability parity with the TS surface with no silent gap**, stand up the **Python neutrality-scan analog** as a standing zero-vendor gate, and — the load-bearing R1 lesson — verify with **real-stack probes + negative controls**, not self-consistent tests. It is the Python realization of TS `E11-CORE-adoption-audit`. This epic closes the cycle. Informed by the architect consult (2026-07-09), Cluster 4, and the R1 hardening lesson (HISTORY.md).

## Success criteria

- A **capability-parity matrix vs the TS surface**: every TS capability is ruled direct-analog / idiomatic-adaptation / **N-A-by-platform** / **declared-but-unimplemented slot**, with:
  - **Browser-only N-A-by-platform rows** (browser persistence, autocapture, pageviews, cross-subdomain cookies, sendBeacon/unload, the anon→identified merge, runtime `register`/`unregister`) **explicitly documented as by-design server-shaped omissions** — no silent gap.
  - **Declared-but-unimplemented capability-port rows** — `flags?` (`FeatureFlagPort`) and `replay?` (`SessionReplayPort`): the Python seam DECLARES both optional `Protocol` slots (PY2, defaulting to `None`) exactly as TS declares them `undefined`-in-R1, so these are parity-PRESENT-as-slots rows (matching TS-E11's flags/replay by-design-omitted-slot rows), NOT browser-N-A rows. `replay` is a declared slot AND browser-shaped in practice; `flags` is a declared slot the UPCOMING feature-flags cycle will fill server-side.
  - The **taxonomy compile-time guarantee gap** (Python = runtime-registry parity + best-effort static, NOT TS-parity — PY3's PM-locked promise).
- A **Python neutrality-scan analog** (`scripts/neutrality_scan.py`) runs as a standing gate: it scans **(a) the built wheel + sdist contents** (surface + runtime-value dimensions) and **(b) the `src/analytics_kit/` tree via `ast`** (wire-confinement), classifying **by dimension** (what a consumer can observe), exit-nonzero on any violation, asserted by a `pytest` test. NOT a ruff plugin, NOT raw grep.
- **Wire-vocabulary confinement is proven**: the `ast` pass PASSES `$`-prefixed / wire string literals ONLY as the value of a module-level `_WIRE_*`-named constant inside an adapter submodule — everything else fails. A new adapter's wire token passes the SAME gate with zero scan edits iff it obeys the convention.
- The **provenance-comment exemption is explicit**: dev-facing `# De-branded from posthog's …` comments are AST-exempt by construction (the `ast` pass never sees `#` comments); the epic locks that these comments MAY reach the shipped wheel (Python ships source; they can't be stripped without a build step) — a deliberate, documented divergence from the TS model (which strips them so they never reach `dist`).
- **Both acceptance bars re-proven** as re-runnable gated proofs: bar A (provider-swap = one adapter, zero consumer change — the warehouse-query stub + the no-op adapters) and bar B (the PY7 example type-checking against the installed distribution).
- **"All gates green ≠ correct"** is baked in: the audit includes **real-stack probes** (a real capture round-trips to a real/staging endpoint; a real query returns a real shape) + **negative controls** (an off-list key is actually rejected; an unkeyed client actually sends nothing; a `dedupe_id` retry is actually idempotent) — not just self-consistent unit tests. Ground truth is checked against `posthog-python` behavior where relevant.
- A README interface→implementation matrix + an "adopt in a new app" (config-only) section, mirroring the TS docs.

## Stories

_Tentative slice (story files not yet written):_

- **S1** — the capability-parity matrix vs the TS surface (direct / idiomatic / N-A rows, the taxonomy-guarantee-gap statement) + the README interface→implementation + adopt-in-a-new-app sections.
- **S2** — the neutrality-scan analog: `scripts/neutrality_scan.py` scanning the wheel/sdist (surface + value dimensions) + the `ast` wire-confinement pass over `src/`, the `_WIRE_*` confinement convention, the provenance-comment AST exemption; exit-nonzero, wrapped by a `pytest` gate.
- **S3** — the real-stack probes + negative controls (round-trip capture, real query shape, off-list rejection, unkeyed silence, dedupe idempotency) + the re-runnable bar-A/bar-B proofs.

## Out of scope

- Fixing capability gaps found by the audit — if the matrix finds a real (non-N-A) gap, that's a bug/story against the owning epic, not audit scope. The audit's job is to SURFACE gaps, not silently paper them.
- A CI pipeline — the gate runs locally via `uv`/`pytest`, CI-wired later (infra).
- Wiring `python -m build` into the every-commit inner loop (see Notes — PM-locked to CI-only for the wheel scan).

## Notes

- **Neutrality-scan targets + mechanism.** — architect (2026-07-09, Cluster 4, high): Python has no tsup/dist — the shipped artifact is the **wheel/sdist** (payload ≈ `src/` + metadata). Map the TS scan's dimensions: declaration/js-bundle → scan the wheel's `.py`/`.pyi` for forbidden tokens + string-literal values; wire-confinement → `ast` pass over `src/` PASSING `$`-literals only under `_WIRE_*` module-level constants (the exact TS `WIRE_CONST_NAME` convention); package/file-name → distribution name + module paths; doc → README/prose (no exemption). A **standalone script asserted by pytest**, NOT a ruff plugin (ruff can't scan the built wheel) and NOT raw grep (false-fails on provenance comments + confined `$`-literals — the same reasoning the TS scan documents).
- **Provenance-comment exemption is CLEANER but DIVERGES from TS.** — architect (2026-07-09, Cluster 4): the `ast` pass never sees `#` comments, so `# De-branded from posthog's …` is exempt by construction (no comment-stripping needed). BUT Python ships *source*, so the comment reaches the wheel — unlike TS, which strips it at build so it never reaches `dist`. **PM-locked (2026-07-09): allow provenance comments to reach the wheel, scanned only as AST-exempt comments** — a deliberate, documented divergence from the TS model, not an accident. Lock it in the matrix.
- **PM-locked (2026-07-09): `src/` AST scan on every commit; wheel scan in CI only.** Resolves the architect's surviving open question #4 (wheel-build-in-gate vs src-only inner loop). Keeps the inner loop fast (no `python -m build` per commit) while the wheel scan still gates CI. Standard split.
- **"All gates green ≠ correct" — the R1 lesson, cross-language.** — PM (2026-07-09), from HISTORY.md: R1 shipped all-gates-green but carried real defects the self-consistent tests had encoded as correct (a vendor leak in `dist`, zero-ingestion, privacy/consent violations, name collisions from de-branding). The Python audit must include real-stack probes + negative controls + ground-truthing vs `posthog-python` — NOT just tests that agree with the code. This is a hard requirement of the audit, not a nice-to-have.
- **N-A rows are documented omissions, not gaps — and are distinct from declared-slot rows.** The browser-only surface (persistence, autocapture, pageviews, cross-subdomain cookies, sendBeacon, merge, runtime register/unregister) is by-design-omitted server-side (the parity rule is *server-shaped*). SEPARATELY, `flags?`/`replay?` are declared-but-unimplemented capability-port SLOTS on the Python seam (PY2, `None`-default) — parity-present-as-slots, not N-A-by-platform. The matrix names each row explicitly so parity is auditable — the TS-E11 by-design-omitted-slot precedent (flags/replay) plus the browser-N-A rows, kept as two distinct categories so a reader can tell "server has no analog" from "declared, awaiting the owning cycle."

## Expansion path

The parity matrix + neutrality scan are re-run each time a capability lands (feature-flags, an async client, a new framework binding, a self-hosted adapter) — the standing gate that keeps both languages at parity and the surface vendor-free as it grows.
