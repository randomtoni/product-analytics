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
- The trivial test lands in each package as `src/index.test.ts` (or under `src/__tests__/`), discovered by that package's own `vitest.config.ts` (added in S2/S3, merging the root `vitest.shared.ts`). No new config wiring should be needed here — if a package's test isn't discovered, the fix is that package's `vitest.config.ts`/`include`, not a root-level change. Node env suffices for these trivial assertions (no jsdom).
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
- Cache expectation follows the `inputs`/`globalDependencies` pinned in S1's `turbo.json`: `build` is cacheable keyed on its explicit `inputs` (`src/**`, `tsconfig.json`, `tsup.config.ts`, `package.json`) plus the shared root configs in `globalDependencies`; a no-change re-run reports cache hits (`FULL TURBO`). `lint` has no `dependsOn`; `typecheck`/`test`/`build` depend on `^build`.
- **`.mjs`/`.js` output naming** — the AC that every package emits `.mjs` (ESM) + `.js` (CJS) holds only because no package sets `"type": "module"` (pinned in S2/S3). If a build emits a `.cjs` or an ESM `.js` instead, the cause is a stray `"type": "module"` in that package.json — fix the package.json, don't repoint the exports map.
- > Reviewer suggestion (2026-07-07): keep explicit `import { expect, test } from 'vitest'` (not globals) — under `include:["src"]` globals would need `types:["vitest/globals"]` per tsconfig; explicit imports sidestep that with zero config and stay fine for E2+ real tests. No change now.
- > Reviewer suggestion (2026-07-07, E2 readiness — deferred, not an E1 defect): E2 must ADD (not fix) before its own gates pass — (a) `@types/react` devDep + a `jsx` tsconfig option for `@analytics-kit/react` (JSX + real React types), (b) a `jsdom`/`happy-dom` `environment` in `browser`/`react` `vitest.config.ts` for DOM-touching tests. The per-package `mergeConfig` / per-package tsconfig override seams already exist — clean drop-ins, no root/structural change.

## Shipped

> Captured by `implement-epics` on 2026-07-07.

- **Files added:** `packages/{analytics-kit,browser,node,react}/src/index.test.ts` (4 trivial tests, one per package)
- **Files changed:** none
- **New public API:** none — tests only
- **Tests added:** `exposes the package version` ×4 — each imports `{ version }` from `./index` and asserts `toBe('0.0.0')`; explicit `import { expect, test } from 'vitest'` (no globals)
- **Commit:** `E1-S4-gates-green-end-to-end — All four gates green on empty packages` on `core-cycle`
- **Reviewer notes:** see Technical notes — 2 suggestions (keep explicit vitest imports; E2 readiness re: react types/jsx + jsdom env); 0 critical
- **Epic success bar met:** all four gates (`typecheck`/`lint`/`test`/`build`) green end-to-end across all four packages, each running a real (non-`passWithNoTests`) test; seam builds before targets; second run `FULL TURBO` cache hit; `grep -ri posthog` clean.
