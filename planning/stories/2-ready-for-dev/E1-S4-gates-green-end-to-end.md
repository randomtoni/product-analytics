---
id: E1-S4-gates-green-end-to-end
epic: E1-CORE-workspace-scaffold
status: ready-for-dev
area: core
touches: [browser, node, react]
depends_on: [E1-S3-target-package-skeletons]
api_impact: additive
---

# E1-S4-gates-green-end-to-end — All four gates green on empty packages

## Why

The epic's success bar is not "packages exist" but "all four quality gates pass end-to-end across every package." This slice adds a trivial passing test to each package and proves the full `typecheck` / `lint` / `test` / `build` sweep is green through turbo — the definition of a done scaffold.

## Scope

### In

- A single trivial passing vitest test in each of the four packages (`analytics-kit`, `@analytics-kit/{browser,node,react}`) — e.g. asserting the package's placeholder export — so the `test` gate exercises a real (not `passWithNoTests`) case per package.
- Verify/wire each package's `test` script against the shared vitest config so the tests are discovered.
- Run the full sweep and confirm all four turbo tasks are green across all four packages: `turbo run typecheck`, `turbo run lint`, `turbo run test`, `turbo run build`.
- Confirm turbo caching: a second identical gate run is served from cache for unchanged packages.

### Out

- Any non-trivial test or real functionality (that's E2+).
- CI pipeline config (infra; deferred per epic Out-of-scope).
- Publishing / registry / versioning setup.

## Acceptance criteria

- [ ] `turbo run typecheck` — exit 0 across all four packages.
- [ ] `turbo run lint` — exit 0 across all four packages.
- [ ] `turbo run test` — exit 0; each of the four packages runs **at least one** passing test (not just `passWithNoTests`).
- [ ] `turbo run build` — exit 0; every package emits `dist` with ESM (`.mjs`) + CJS (`.js`) + `.d.ts`, and `analytics-kit` is built before the targets (topo via `^build`).
- [ ] Re-running any gate immediately is served from turbo cache (`FULL TURBO` / cache hit) for unchanged packages.
- [ ] `grep -ri posthog` across the workspace source/config is clean — zero vendor references in any package name, file name, or config.

## Technical notes

- This is the epic's third Stories bullet made concrete: "a trivial passing test per package so `test` / `typecheck` / `lint` / `build` all pass end-to-end." Keep each test one-liner-trivial; it exists only to prove the gate wiring, not to test behavior.
- Once real tests exist per package, the shared vitest `passWithNoTests: true` (from S1) becomes a safety net rather than the reason a package is green — leave it in place for future empty slices.
- **Gate task names are fixed** by CLAUDE.md: `turbo run typecheck | lint | test | build`. Do not rename to posthog's `check-types`.
- **Do not hit any real backend** in tests (CLAUDE.md conventions) — trivial in-process assertions only; no network.
- Cache expectation follows `posthog-js/turbo.json` semantics: `build` is cacheable keyed on `src/**` + config `inputs`; a no-change re-run should report cache hits. `lint` has no `dependsOn`; `typecheck`/`test`/`build` depend on `^build`.

## Shipped

<!-- Empty at draft. /implement-epics fills this once, when the story moves to stories/5-done/
(files changed/added, new public API, tests added, commit, reviewer notes). Do not hand-edit. -->
