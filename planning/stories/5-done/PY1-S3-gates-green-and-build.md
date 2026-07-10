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
- [ ] The built **wheel contains `analytics_kit/py.typed`** AND the S2 submodule files — specifically `analytics_kit/client.py`, `analytics_kit/query.py`, `analytics_kit/taxonomy.py`, `analytics_kit/allowlist.py`, and **`analytics_kit/integrations/__init__.py`** (this last is the load-bearing one — an `integrations/` without `__init__.py` is silently dropped from the wheel; see Technical notes). Confirm by inspecting the built artifact directly, e.g. `python3 -m zipfile -l dist/analytics_kit-*.whl` (verified during refinement: `python3 -m zipfile -l` lists these entries; do not trust the source tree). 
- [ ] `grep -ri posthog python/src python/tests python/pyproject.toml` is clean — zero vendor references anywhere in the built surface.

## Technical notes

- **This is the epic's gate bar made concrete** — the Python analog of TS `E1-S4` ("all four gates green end-to-end"). The Python gate set is three (`pytest` / `ruff` / `mypy`-strict) plus the build (there is no separate `typecheck` vs `build` split like TS's tsc-vs-tsup — mypy is the type gate, `uv build` is the artifact gate).
- **`py.typed` in the wheel is a load-bearing check — but expected to pass with no extra config.** Verified during refinement: the scaffold's `[tool.hatch.build.targets.wheel] packages = ["src/analytics_kit"]` ships `py.typed` automatically (the `packages` directive copies the whole package dir, not just `.py` files), so S1 does NOT add a `force-include`/`artifacts` entry and none is expected in the wheel-build path. S3 is the *guard*: it inspects the wheel and confirms `py.typed` is present. If — and only if — the marker is somehow missing (e.g. a later config change to an `include`-glob that filters by extension), the fix is a hatch include entry back in S1, not a test workaround. Inspect the wheel directly (`python3 -m zipfile -l dist/analytics_kit-*.whl`) rather than trusting the source tree.
- **`integrations/__init__.py` in the wheel is the other load-bearing check** — an `integrations/` created as a bare directory (no `__init__.py`) imports in the dev editable install but is silently absent from the built wheel (hatchling ships files, not empty dirs; verified during refinement). The wheel-contents AC explicitly lists `analytics_kit/integrations/__init__.py` for this reason; if it's missing from the wheel, the fix is adding the `__init__.py` in S2, not here.
- **Keep tests trivial** — one-line imports + asserts, no network, no real backend (CLAUDE.md convention: never hit a real analytics backend). These prove gate wiring only.
- **Test imports resolve via pytest's path config, not `sys.path` hacking** — `[tool.pytest.ini_options] pythonpath = ["src"]` is already set, so a plain `import analytics_kit.client` inside `test_scaffold.py` resolves under `uv run pytest` with no `sys.path` manipulation or `importlib` guard. Just write the bare `import` statements. (Note the asymmetry with S2's *ad-hoc* AC command, which must be `uv run python -c "…"` because it runs outside pytest and needs the venv's editable install to resolve the package.)
- **mypy strict on the skeleton** — the S1/S2 skeleton is strict-clean by construction (docstrings + typed empty `__all__`). If mypy trips, the fix belongs in the offending S1/S2 file (a missing annotation), not a `# type: ignore` here.
- **`uv build` backend** — the scaffold uses hatchling (`[build-system] requires = ["hatchling"]`); `uv build` drives it. Both wheel + sdist are required so the sdist path (used by consumers building from source) is proven too.
- **No CI here** — the gates run locally via `uv`; CI wiring is deferred infra (epic Out-of-scope), same posture as the TS scaffold.

## Shipped

> Captured by `implement-epics` on 2026-07-09.

- **Files changed:** `python/tests/test_scaffold.py` (added `test_submodules_import` + submodule imports)
- **Files added:** none
- **New public API:** `none — gate/build proof only`
- **Tests added:** `test_submodules_import` (trivial import-wiring proof for the 5 S2 submodules); existing `test_package_imports_with_version` unchanged
- **Commit:** `core-cycle` (message = story title; find via `git log --grep`)
- **Reviewer notes:** `none` — approved first pass; reviewer negative-controlled mypy-strict (injected an untyped def → confirmed failure) and independently rebuilt + full-extraction-grepped both artifacts
- **Epic bar met:** locked toolchain (pytest · ruff · mypy-strict) green on the empty seam; `uv build` produces a valid wheel + sdist shipping `py.typed` + all five submodules (incl. load-bearing `integrations/__init__.py`); **both built artifacts full-extraction posthog-clean** (the real neutrality bar, not just a source grep). This is the signal that PY1 is done.
