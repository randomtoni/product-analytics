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
- Add the `py.typed` marker file at `python/src/analytics_kit/py.typed` (empty file — PEP 561) so the installed distribution is type-checkable by consumers. The existing `[tool.hatch.build.targets.wheel] packages = ["src/analytics_kit"]` already ships every file under the package dir (including `py.typed`) — **do NOT add a redundant `force-include`/`artifacts` entry** unless a build inspection proves the marker is being dropped (see Technical notes; verified: with the current `packages` config, `py.typed` lands in the wheel with no extra include config). S1's job is to make the marker file exist; S3 proves it ships.
- Confirm the distribution metadata carries **zero vendor tokens** (name, description, classifiers, URLs) — `analytics-kit` / `analytics_kit` only.

### Out

- The submodule skeleton (`client`/`query`/`taxonomy`/`allowlist`/`integrations/`) — that's **S2**.
- Any framework *binding code* under `integrations/` — that's **PY6**; S1 only declares the extras.
- The gates-green + wheel/sdist build proof — that's **S3** (S1 makes the extras + `py.typed` exist; S3 proves the built artifact contains `py.typed`).
- Any seam / adapter / taxonomy / capture logic (PY2–PY5).
- Re-deciding the toolchain — LOCKED (uv · pytest · ruff · mypy-strict · Pydantic).

## Acceptance criteria

- [ ] `python/pyproject.toml` declares `[project.optional-dependencies]` with `django`, `fastapi`, and `all` extras; `all` unions the framework extras.
- [ ] `python/src/analytics_kit/py.typed` exists (empty PEP 561 marker). The existing `[tool.hatch.build.targets.wheel] packages = ["src/analytics_kit"]` config already packages it — verified during refinement that a bare `uv build` ships `analytics_kit/py.typed` in the wheel with no extra include config. (S3 asserts this on the built artifact.)
- [ ] The distribution stays **one** distribution named `analytics-kit` (import package `analytics_kit`) — no second distribution introduced; no module named `core`.
- [ ] `uv sync --extra all` resolves with no error. (Extras are declared under `[project.optional-dependencies]`, so `--extra` is the resolver flag; the `dev` group already resolves via the default `uv sync`.)
- [ ] `uv run ruff check` and `uv run mypy` stay green after the pyproject changes (no regression from the existing scaffold).
- [ ] Zero vendor token in the distribution name, metadata, or any path: a `grep -ri posthog python/pyproject.toml python/src` is clean.

## Technical notes

- **LOCKED — one distribution + extras, NOT multiple distributions.** — architect (2026-07-09, Cluster 3, high). The TS `@analytics-kit/*` split is an npm runtime-separation artifact (browser vs node bundles, tree-shaking); the Python port is server-only single-runtime, so that rationale is gone. Python idiom for optional deps is **extras** (`pip install analytics-kit[django]`), not separate distributions. "Adopt only what you need" is satisfied by extras + lazy `try/except ImportError` imports inside `integrations/` (PY6), not by separate distributions. Do NOT introduce `analytics-kit-core` / `analytics-kit-django`.
- **Import package vs distribution name:** distribution `analytics-kit` (hyphen, PyPI), import package `analytics_kit` (underscore). Both are already correct in the scaffold — preserve them.
- **`py.typed` packaging with hatchling — verified, no extra config needed:** hatchling's `packages = ["src/analytics_kit"]` directive ships the *whole* package directory, not just `.py` files, so the non-`.py` `py.typed` marker is included automatically. Verified during refinement: dropping an empty `py.typed` into `src/analytics_kit/` and running a bare `uv build` produced a wheel containing `analytics_kit/py.typed` with **no** `force-include`/`artifacts`/`include` entry. Do NOT add redundant include config — it's dead config against this layout. (The failure mode the PM flagged — hatchling silently dropping empty non-`.py` markers — applies to `include`-glob or `only-include` configs that filter by extension, not to the `packages` directive this scaffold uses.) S3 is the guard: it inspects the built wheel and, *only if* the marker is missing, the fix is a hatch include entry in S1 — but on the current config it should already be present.
- **Extras declarations only, no binding code — and no framework import yet:** PY6 owns the Django/FastAPI middleware. PY1 declares the extras so the packaging surface exists; the `integrations/` submodule that consumes them is created empty-but-importable in S2 and filled in PY6. **Coordination with S2/S3:** declaring an extra only adds an *optional dependency name* to metadata — it does NOT make the framework importable in the library, and S2's `integrations/` must import **no** framework. The `uv sync --extra all` AC proves the extras *resolve* (the dep names are valid + installable); it does NOT require any `analytics_kit` code to import Django/FastAPI. Keep `--extra all` out of the mypy/ruff/pytest gate invocation in S3 unless the gate needs it — the empty skeleton gates green without the frameworks installed, and pulling them in would only slow the gate.
- **posthog-python is the de-branding reference** for the packaging shape (one flat package, integrations as submodules) — but its concrete `pyproject.toml` carries many extras/tooling entries out of BRIEF scope; port only the shape (one distribution, extras for optional framework deps), not its full dependency list.
- **No vendor tokens** anywhere a consumer can observe — name, description, classifiers, URLs. The `py.typed` + neutrality posture is what PY8's scan will assert; S1 just keeps the surface clean.

## Shipped

<!-- Captured by implement-epics on close. -->
