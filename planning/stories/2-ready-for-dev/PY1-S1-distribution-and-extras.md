---
id: PY1-S1-distribution-and-extras
epic: PY1-NODE-python-scaffold
status: ready-for-dev
area: node
touches: []
depends_on: []
api_impact: additive
---

# PY1-S1-distribution-and-extras — Distribution shape, extras map & `py.typed`

## Why

The restructure already created a partial `python/` scaffold (`pyproject.toml` + a lone `src/analytics_kit/__init__.py` + a scaffold test). This slice EXTENDS that scaffold to the epic's packaging contract: the one-distribution `analytics-kit` shape with the `[project.optional-dependencies]` extras map and the `py.typed` marker. It ships no submodules and no seam logic — only the packaging surface later epics inherit. Everything downstream depends on the distribution being shaped correctly on day one.

## Scope

### In

- Extend the existing `python/pyproject.toml` (do NOT re-create it — it already declares `name = "analytics-kit"`, `pydantic>=2`, the `dev` dependency-group with pytest/ruff/mypy, hatchling backend, and ruff/mypy-strict/pytest config):
  - Add `[project.optional-dependencies]` with **`django`**, **`fastapi`**, and **`all`** extras. The extras are declared here even though the binding *code* is PY6 — PY1 owns the declarations, PY6 fills the `integrations/` submodules. `all` unions the framework extras. Leave the concrete framework version pins minimal/reasonable (e.g. `django>=4`); the binding code that consumes them is out of scope.
  - Ensure the `py.typed` marker is packaged: add `analytics_kit` to hatch's package data / force-include so `py.typed` ships in the wheel (see Technical notes).
- Add the `py.typed` marker file at `python/src/analytics_kit/py.typed` (empty file — PEP 561) so the installed distribution is type-checkable by consumers.
- Confirm the distribution metadata carries **zero vendor tokens** (name, description, classifiers, URLs) — `analytics-kit` / `analytics_kit` only.

### Out

- The submodule skeleton (`client`/`query`/`taxonomy`/`allowlist`/`integrations/`) — that's **S2**.
- Any framework *binding code* under `integrations/` — that's **PY6**; S1 only declares the extras.
- The gates-green + wheel/sdist build proof — that's **S3** (S1 makes the extras + `py.typed` exist; S3 proves the built artifact contains `py.typed`).
- Any seam / adapter / taxonomy / capture logic (PY2–PY5).
- Re-deciding the toolchain — LOCKED (uv · pytest · ruff · mypy-strict · Pydantic).

## Acceptance criteria

- [ ] `python/pyproject.toml` declares `[project.optional-dependencies]` with `django`, `fastapi`, and `all` extras; `all` unions the framework extras.
- [ ] `python/src/analytics_kit/py.typed` exists (empty PEP 561 marker) and the hatch build config packages it (force-include / package-data), so it lands in the wheel.
- [ ] The distribution stays **one** distribution named `analytics-kit` (import package `analytics_kit`) — no second distribution introduced; no module named `core`.
- [ ] `uv sync` (and `uv sync --extra all`) resolves with no error.
- [ ] `uv run ruff check` and `uv run mypy` stay green after the pyproject changes (no regression from the existing scaffold).
- [ ] Zero vendor token in the distribution name, metadata, or any path: a `grep -ri posthog python/pyproject.toml python/src` is clean.

## Technical notes

- **LOCKED — one distribution + extras, NOT multiple distributions.** — architect (2026-07-09, Cluster 3, high). The TS `@analytics-kit/*` split is an npm runtime-separation artifact (browser vs node bundles, tree-shaking); the Python port is server-only single-runtime, so that rationale is gone. Python idiom for optional deps is **extras** (`pip install analytics-kit[django]`), not separate distributions. "Adopt only what you need" is satisfied by extras + lazy `try/except ImportError` imports inside `integrations/` (PY6), not by separate distributions. Do NOT introduce `analytics-kit-core` / `analytics-kit-django`.
- **Import package vs distribution name:** distribution `analytics-kit` (hyphen, PyPI), import package `analytics_kit` (underscore). Both are already correct in the scaffold — preserve them.
- **`py.typed` packaging with hatchling:** an empty `py.typed` alone isn't enough — hatchling must be told to include it. The existing `[tool.hatch.build.targets.wheel] packages = ["src/analytics_kit"]` includes `.py` files; add a force-include / `artifacts` (or `[tool.hatch.build] include`) entry so the non-`.py` `py.typed` marker is packaged. S3 asserts it actually lands in the built wheel.
- **Extras declarations only, no binding code:** PY6 owns the Django/FastAPI middleware. PY1 declares the extras so the packaging surface exists; the `integrations/` submodule that consumes them is created empty-but-importable in S2 and filled in PY6.
- **posthog-python is the de-branding reference** for the packaging shape (one flat package, integrations as submodules) — but its concrete `pyproject.toml` carries many extras/tooling entries out of BRIEF scope; port only the shape (one distribution, extras for optional framework deps), not its full dependency list.
- **No vendor tokens** anywhere a consumer can observe — name, description, classifiers, URLs. The `py.typed` + neutrality posture is what PY8's scan will assert; S1 just keeps the surface clean.

## Shipped

<!-- Captured by implement-epics on close. -->
