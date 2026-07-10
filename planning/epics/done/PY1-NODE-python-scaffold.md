---
id: PY1-NODE-python-scaffold
status: done
area: node
touches: []
api_impact: additive
blocked_by: []
updated: 2026-07-09
---

# PY1-NODE-python-scaffold — Python workspace & toolchain scaffold

## Why

The `python/` tree is the substrate every other Python-parity epic builds on — nothing can be ported or de-branded until the uv package exists with the locked toolchain and all gates green on an empty seam. This is the Python analog of the TS `E1-CORE-workspace-scaffold`: encode the packaging shape (one distribution + extras) and the gate discipline on day one so later epics inherit them. Informed by the architect consult (2026-07-09), Cluster 3.

## Success criteria

- `python/` is **one distribution** named `analytics-kit` (import package `analytics_kit`) under `src/`, with optional framework deps behind **extras** (`analytics-kit[django]`, `analytics-kit[fastapi]`, `analytics-kit[all]`) — NOT multiple PyPI distributions. Submodules are the unit of structure (`analytics_kit.client`, `analytics_kit.query`, `analytics_kit.taxonomy`, `analytics_kit.allowlist`, `analytics_kit.integrations.*`).
- The locked toolchain runs green on the empty seam: `uv run pytest` (vitest analog) · `uv run ruff check` (eslint analog) · `uv run mypy` **strict** (tsc `--noEmit` analog) · a build produces a valid wheel + sdist.
- `py.typed` marker ships so the distribution is type-checkable by consumers.
- Zero vendor reference in the distribution name, import package name, any module path, or config. `analytics_kit` passes; a `posthog`-named module would fail.
- No module literally named `core` (matches the TS rule — "core" survives only as the area slug); the seam lives at the top of `analytics_kit`.

## Development prerequisites

- The `posthog-python` reference checkout is cloned at the repo root beside `posthog-js/` (SATISFIED — cloned 2026-07-09). It is the de-branding reference for the Python port, same status as `posthog-js` for TS.

## Stories

Linear chain — `S1 → S2 → S3` (each depends on the prior). All three EXTENDED the existing partial scaffold — none re-created it. All shipped.

- **[PY1-S1](../../stories/5-done/PY1-S1-distribution-and-extras.md)** *(done — `4616cc0`)* — extended `pyproject.toml` to the one-distribution `analytics-kit` shape: `[project.optional-dependencies]` `django`/`fastapi`/`all` extras + `py.typed` marker + sdist `only-include` + vendor-free `python/.gitignore`; neutralized the README long-description + `__init__.py` docstring (both ship in the artifact). Retry ×1 — adversarial wheel-build found four vendor tokens a source grep missed.
- **[PY1-S2](../../stories/5-done/PY1-S2-submodule-skeleton.md)** *(done — `05874ad`)* — created the empty-but-importable submodule skeleton (`client`/`query`/`taxonomy`/`allowlist` single files + `integrations/` package) as docstring-only neutral placeholders; no seam surface pre-stubbed, no `core` module.
- **[PY1-S3](../../stories/5-done/PY1-S3-gates-green-and-build.md)** *(done — `cf74c34`)* — proved gates green end-to-end (`pytest`/`ruff`/`mypy`-strict) + `uv build` wheel + sdist, wheel confirmed to ship `py.typed` + all five submodules, and **both built artifacts full-extraction posthog-clean**.

Build topo order: `PY1-S1 → PY1-S2 → PY1-S3`.

## Out of scope

- Any seam / adapter / taxonomy / capture logic (PY2–PY5).
- The framework bindings (PY6) — only the `[django]`/`[fastapi]` extras *declarations* land here; the binding code is PY6.
- The neutrality-scan analog (PY8) — the scan *script* is PY8; PY1 only ensures the layout it will scan exists.
- CI pipeline config (infra; gates run locally via uv, CI-wired later).

## Notes

- **Toolchain LOCKED — do not re-decide.** uv · pytest · ruff · mypy(strict) · Pydantic. Set in root CLAUDE.md; not open for re-litigation.
- **One distribution + extras, not multiple distributions.** — architect (2026-07-09, Cluster 3, high confidence): the TS `@analytics-kit/*` split exists for npm runtime separation (browser vs node bundles, tree-shaking); the Python port is **server-only single-runtime**, so that rationale is gone. Python idiom for optional deps is **extras** (`pip install analytics-kit[django]`), not separate distributions. posthog-python's own reality is one flat package with `integrations/` submodules. "Adopt only what you need" is satisfied by extras + lazy `try/except ImportError` imports inside `integrations/`, not by separate distributions. Rejected alternative: `analytics-kit-core` / `analytics-kit-django` mirroring the TS workspace — imports npm's split into an ecosystem where extras are idiomatic, for zero capability gain.
- **Epics slice by submodule, not distribution.** One `pyproject.toml`; the cycle's later epics fill submodules under the same `analytics_kit` package.

## Expansion path

A new framework binding or backend adapter is a new submodule (+ optional extra) under the same single distribution — additive, no change to the seam or the packaging shape.
