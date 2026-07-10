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

- Under `python/src/analytics_kit/`, create empty-but-importable submodules (a package `__init__.py` or a plain module file, each with a neutral placeholder docstring and NO seam surface):
  - `client` — the server client seam lands here (PY2/PY4).
  - `query` — the query client seam lands here (PY5).
  - `taxonomy` — the typed-taxonomy mechanism lands here (PY3).
  - `allowlist` — the payload-allowlist enforcement lands here (PY3).
  - `integrations/` — a package (with `__init__.py`) that will hold the framework bindings (PY6). Empty package, no framework imports yet.
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
- [ ] `python -c "import analytics_kit, analytics_kit.client, analytics_kit.query, analytics_kit.taxonomy, analytics_kit.allowlist, analytics_kit.integrations"` succeeds (all importable, no error).
- [ ] No module or package is named `core`; the top-level `analytics_kit` remains the seam entry.
- [ ] Each new module carries only a neutral placeholder (docstring / empty `__all__`) — no `Protocol`, dataclass, or seam type is pre-stubbed.
- [ ] `uv run mypy` (strict) and `uv run ruff check` stay green across the new skeleton.
- [ ] Zero vendor token in any new module path, name, or content: `grep -ri posthog python/src` is clean.

## Technical notes

- **Submodules are the unit of structure** (epic Notes; architect 2026-07-09, Cluster 3). One distribution `analytics-kit`, submodules `analytics_kit.{client,query,taxonomy,allowlist,integrations}`. This mirrors posthog-python's flat-package-with-submodules reality (de-branded), NOT the TS multi-package split.
- **Empty-but-importable, not pre-stubbed:** the TS scaffold analog (`E1-S2`) kept `src/index.ts` a genuine placeholder and deferred all real surface to E2/E3. Do the same — a docstring + optional empty `__all__`. Pre-stubbing a `Protocol` here would force PY2 to re-litigate its shape.
- **`integrations/` is a package** (needs `__init__.py`) because PY6 adds `integrations/django.py`, `integrations/fastapi.py` etc. under it. It imports NO framework at this stage — the lazy `try/except ImportError` framework imports are PY6's job.
- **mypy strict on empty modules:** an empty module with a docstring is strict-clean. If a placeholder needs a symbol to be import-testable, prefer `__all__: list[str] = []` (typed) over an untyped stub, so strict mypy stays green.
- **No `core` module** (epic success criteria) — "core" survives only as the area slug; the seam is the top-level `analytics_kit`. Same rule the TS side enforced (no package literally named `core`).

## Shipped

<!-- Captured by implement-epics on close. -->
