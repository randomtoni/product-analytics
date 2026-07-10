---
id: PY1-S2-submodule-skeleton
epic: PY1-NODE-python-scaffold
status: ready-for-dev
area: node
touches: []
depends_on: [PY1-S1-distribution-and-extras]
api_impact: additive
---

# PY1-S2-submodule-skeleton — Empty-but-importable submodule skeleton

## Why

Epics slice by submodule, not distribution. The later cycle epics (PY2 seam, PY3 taxonomy/allowlist, PY4 capture, PY5 query, PY6 bindings) each fill a submodule under the single `analytics_kit` package. This slice creates those submodules as empty-but-importable neutral placeholders so the import graph and the layout PY8's neutrality scan will target exist from day one — without pre-stubbing any seam surface.

## Scope

### In

- Under `python/src/analytics_kit/`, create empty-but-importable submodules, each with a neutral placeholder docstring and NO seam surface. **Shape (pinned during refinement — verified mypy-strict + ruff clean + shipping in the wheel):** the four leaf submodules are **single-file modules** (`client.py`, `query.py`, `taxonomy.py`, `allowlist.py`), and `integrations/` is a **package** (a real `integrations/__init__.py`):
  - `client.py` — the server client seam lands here (PY2/PY4).
  - `query.py` — the query client seam lands here (PY5).
  - `taxonomy.py` — the typed-taxonomy mechanism lands here (PY3).
  - `allowlist.py` — the payload-allowlist enforcement lands here (PY3).
  - `integrations/__init__.py` — the package that will hold the framework bindings (PY6). Empty package (docstring only), no framework imports yet. **Must have a real `__init__.py`** — an empty `integrations/` *directory* (namespace package, no `__init__.py`) imports fine in the editable dev install but is **silently absent from the built wheel** (hatchling ships files, not empty dirs) and won't survive a git commit either. Verified during refinement: without `__init__.py`, `analytics_kit.integrations` does not appear in `uv build`'s wheel. So the `__init__.py` is load-bearing, not optional.
- Keep the existing `src/analytics_kit/__init__.py` as the top-level neutral entry (it already carries the docstring + `__version__`); do NOT relocate the seam into a module named `core`.
- Each new module is a **genuine placeholder** — a docstring and, where a module needs an export to be importable cleanly, a neutral no-op (`__all__: list[str] = []` or nothing). No `Protocol`, adapter, taxonomy, or capture types (those are PY2–PY6).

### Out

- Any seam / adapter / provider / taxonomy / allowlist / capture / query surface — PY2–PY5 fill these modules; S2 only creates the empty shells.
- Any framework binding code inside `integrations/` — PY6.
- The trivial passing test + wheel/sdist build proof — **S3**.
- A module named `core` — forbidden (the seam is the top of `analytics_kit`).
- The extras map / `py.typed` — **S1**.

## Acceptance criteria

- [ ] `python/src/analytics_kit/{client,query,taxonomy,allowlist}` and `python/src/analytics_kit/integrations/` exist as importable modules/packages.
- [ ] `uv run python -c "import analytics_kit, analytics_kit.client, analytics_kit.query, analytics_kit.taxonomy, analytics_kit.allowlist, analytics_kit.integrations"` succeeds (all importable, no error). **Must be `uv run` (not bare `python`)** — the package is not installed on the ambient interpreter; it resolves only via the venv's editable install (`uv run`) or pytest's `pythonpath = ["src"]`. Verified during refinement: a bare `python -c "import analytics_kit"` raises `ModuleNotFoundError`.
- [ ] No module or package is named `core`; the top-level `analytics_kit` remains the seam entry.
- [ ] Each new module carries only a neutral placeholder (docstring / empty `__all__`) — no `Protocol`, dataclass, or seam type is pre-stubbed.
- [ ] `uv run mypy` (strict) and `uv run ruff check` stay green across the new skeleton.
- [ ] Zero vendor token in any new module path, name, or content: `grep -ri posthog python/src` is clean.

## Technical notes

- **Submodules are the unit of structure** (epic Notes; architect 2026-07-09, Cluster 3). One distribution `analytics-kit`, submodules `analytics_kit.{client,query,taxonomy,allowlist,integrations}`. This mirrors posthog-python's flat-package-with-submodules reality (de-branded), NOT the TS multi-package split.
- **Empty-but-importable, not pre-stubbed:** the TS scaffold analog (`E1-S2`) kept `src/index.ts` a genuine placeholder and deferred all real surface to E2/E3. Do the same — a docstring + optional empty `__all__`. Pre-stubbing a `Protocol` here would force PY2 to re-litigate its shape.
- **`integrations/` is a package** (needs a real `__init__.py`) because PY6 adds `integrations/django.py`, `integrations/fastapi.py` etc. under it. It imports NO framework at this stage — the lazy `try/except ImportError` framework imports are PY6's job. The `__init__.py` is not just style: without it the dir is a namespace package that hatchling drops from the wheel and git won't commit (verified during refinement). S3's wheel-inspection AC is what catches a regression here, so keep `analytics_kit/integrations/__init__.py` in the S3 wheel-contents check.
- **mypy strict on empty modules — verified clean:** a module containing only a docstring is strict-clean; no annotation is required and no `__all__` is needed for the import to work (importing the module is enough — the AC's `import analytics_kit.client` succeeds on a docstring-only file). Verified during refinement: `client.py`/`query.py`/`taxonomy.py`/`allowlist.py` as docstring-only files + `integrations/__init__.py` docstring-only passed `uv run mypy` (strict) and `uv run ruff check` with zero issues. Do NOT add a placeholder symbol or `__all__` unless a later need appears — a bare docstring is the minimal strict-clean shape. If a future placeholder ever *does* need an exported symbol, prefer `__all__: list[str] = []` (annotated) over an untyped stub so strict stays green.
- **No `core` module** (epic success criteria) — "core" survives only as the area slug; the seam is the top-level `analytics_kit`. Same rule the TS side enforced (no package literally named `core`).

## Shipped

<!-- Captured by implement-epics on close. -->
