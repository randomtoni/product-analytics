---
id: PY1-S3-gates-green-and-build
epic: PY1-NODE-python-scaffold
status: ready-for-dev
area: node
touches: []
depends_on: [PY1-S2-submodule-skeleton]
api_impact: additive
---

# PY1-S3-gates-green-and-build — Gates green end-to-end + wheel/sdist build

## Why

The epic's success bar is not "the layout exists" but "the locked toolchain runs green on the empty seam AND a valid wheel + sdist build that contains `py.typed`." This slice proves the full gate sweep (`pytest` / `ruff` / `mypy` strict) is green across the S1+S2 skeleton and that the built distribution artifact is valid and ships the `py.typed` marker — the definition of a done Python scaffold, the analog of the TS `E1-S4` end-to-end gate proof.

## Scope

### In

- Extend the existing scaffold test (`python/tests/test_scaffold.py` already imports `analytics_kit` and asserts `__version__`): add trivial passing assertions that the S2 submodules are importable (`analytics_kit.client`, `.query`, `.taxonomy`, `.allowlist`, `.integrations`) so the `pytest` gate exercises the real skeleton, not just the top-level import. Keep every assertion one-liner-trivial — it exists to prove the gate wiring, not to test behavior.
- Run and confirm the full gate sweep is green from the `python/` root: `uv run pytest` · `uv run ruff check` · `uv run mypy` (strict).
- Build the distribution and confirm the artifact is valid and contains `py.typed`: produce a **wheel + sdist** (`uv build`), then confirm the built wheel contains `analytics_kit/py.typed` and the S2 submodules (inspect the wheel contents — see Technical notes).

### Out

- Any non-trivial test or real functionality (PY2+).
- The neutrality-scan analog (PY8) — S3 proves the build works and `py.typed` ships; the vendor-token *scan* of the built wheel is PY8's gate.
- CI pipeline wiring (infra; gates run locally via uv, CI-wired later).
- Publishing / registry / version-bump setup.

## Acceptance criteria

- [ ] `uv run pytest` — exit 0; the scaffold test asserts the top-level import + version AND that all S2 submodules (`client`/`query`/`taxonomy`/`allowlist`/`integrations`) import cleanly.
- [ ] `uv run ruff check` — exit 0 across `src` + `tests`.
- [ ] `uv run mypy` (strict) — exit 0 across `src` + `tests`.
- [ ] `uv build` produces both a **wheel** (`.whl`) and an **sdist** (`.tar.gz`) with no error.
- [ ] The built **wheel contains `analytics_kit/py.typed`** and the S2 submodule files (confirmed by inspecting the wheel — e.g. `python -m zipfile -l dist/*.whl` or `unzip -l`).
- [ ] `grep -ri posthog python/src python/tests python/pyproject.toml` is clean — zero vendor references anywhere in the built surface.

## Technical notes

- **This is the epic's gate bar made concrete** — the Python analog of TS `E1-S4` ("all four gates green end-to-end"). The Python gate set is three (`pytest` / `ruff` / `mypy`-strict) plus the build (there is no separate `typecheck` vs `build` split like TS's tsc-vs-tsup — mypy is the type gate, `uv build` is the artifact gate).
- **`py.typed` in the wheel is the load-bearing check** — S1 adds the marker + the hatch include; S3 proves it actually lands in the built wheel. A common failure is an empty `py.typed` that hatchling silently drops because it isn't `.py`; if the wheel lacks it, the fix is S1's hatch include config, not a test workaround. Inspect the wheel directly (`python -m zipfile -l dist/analytics_kit-*.whl`) rather than trusting the source tree.
- **Keep tests trivial** — one-line imports + asserts, no network, no real backend (CLAUDE.md convention: never hit a real analytics backend). These prove gate wiring only.
- **mypy strict on the skeleton** — the S1/S2 skeleton is strict-clean by construction (docstrings + typed empty `__all__`). If mypy trips, the fix belongs in the offending S1/S2 file (a missing annotation), not a `# type: ignore` here.
- **`uv build` backend** — the scaffold uses hatchling (`[build-system] requires = ["hatchling"]`); `uv build` drives it. Both wheel + sdist are required so the sdist path (used by consumers building from source) is proven too.
- **No CI here** — the gates run locally via `uv`; CI wiring is deferred infra (epic Out-of-scope), same posture as the TS scaffold.

## Shipped

<!-- Captured by implement-epics on close. -->
