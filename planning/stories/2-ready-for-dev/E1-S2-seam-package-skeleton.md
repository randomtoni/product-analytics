---
id: E1-S2-seam-package-skeleton
epic: E1-CORE-workspace-scaffold
status: ready-for-dev
area: core
touches: []
depends_on: [E1-S1-workspace-root-scaffold]
api_impact: additive
---

# E1-S2-seam-package-skeleton — Seam package (`analytics-kit`) skeleton

## Why

`analytics-kit` is the root of the inward-only dependency graph — the vendor-neutral seam every target depends on. It must exist and build standalone (with zero inward or outward runtime deps) before any target package can point at it.

## Scope

### In

- `packages/analytics-kit/package.json`: name **exactly** `analytics-kit`, `version: 0.0.0`, the exports/main/module/types fields (see Technical notes), and the per-package scripts `typecheck` (`tsc --noEmit`), `lint` (`eslint .`), `test` (`vitest run`), `build` (`tsup`). No `dependencies` on any target and no vendor SDK dependency.
- `packages/analytics-kit/tsconfig.json` extending `../../tsconfig.base.json` (`rootDir: src`, `outDir: dist`).
- `packages/analytics-kit/tsup.config.ts` (extends/inlines the shared tsup convention: `entry: ['src/index.ts']`, `format: ['esm','cjs']`, `dts: true`, `clean: true`).
- `packages/analytics-kit/src/index.ts` — a **neutral** placeholder export only (e.g. `export const version = '0.0.0'` or `export {}`). No provider/adapter/taxonomy surface.

### Out

- The `AnalyticsProvider` contract, config-selected factory, and no-op adapter — those are **E2**.
- Typed-taxonomy + allowlist mechanisms — those are **E3**.
- The three target packages (S3).
- The trivial passing test (S4) — the shared vitest `passWithNoTests: true` keeps this package's `test` gate green until then.

## Acceptance criteria

- [ ] `pnpm --filter analytics-kit build` (via tsup) emits `dist/index.js` (CJS) + `dist/index.mjs` (ESM) + `dist/index.d.ts`.
- [ ] `pnpm --filter analytics-kit typecheck` (`tsc --noEmit`), `lint`, and `test` all exit 0.
- [ ] Package name is exactly `analytics-kit` (no `@analytics-kit/` scope, no `core`, no vendor token).
- [ ] `exports["."]` resolves the `types` / `import` / `require` triplet to the tsup outputs; `main`/`module`/`types` top-level fields agree with it.
- [ ] The package declares **no** dependency on any `@analytics-kit/*` target and **no** vendor SDK dependency — it is the root of the inward graph.
- [ ] `grep -ri posthog packages/analytics-kit` is clean.

## Technical notes

- **exports map** — mirror the triplet shape of `posthog-js/packages/core/package.json` (`types` / `import` / `require`), **de-branded** (`@posthog/core` → `analytics-kit`) and repointed at tsup's outputs:
  ```jsonc
  "main": "./dist/index.js",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.ts",
  "exports": { ".": {
    "types": "./dist/index.d.ts",
    "import": "./dist/index.mjs",
    "require": "./dist/index.js"
  } }
  ```
  tsup emits ESM as `.mjs`, CJS as `.js` (with `format: ['esm','cjs']`), and `.d.ts` (with `dts: true`).
- **Dependency direction (locked, epic Notes 2026-07-07)** — inward-only. The seam depends on **no** target; targets depend on it (S3). posthog precedent: `@posthog/core` depends on no browser/node package while `posthog-node` depends on `@posthog/core` (`workspace:^`).
- **Package name (locked)** — the seam is the bare `analytics-kit` (the main entry), not `@analytics-kit/core`; no package is literally named `core`. Scoped `@analytics-kit/*` names are for targets only (S3).
- **tsconfig** — extend the root `tsconfig.base.json` from S1; only override `rootDir`/`outDir`. No DOM lib here (the seam is isomorphic).
- Keep `src/index.ts` a genuine placeholder — real seam surface lands in E2/E3. Do not pre-stub provider/adapter types here.

## Shipped

<!-- Empty at draft. /implement-epics fills this once, when the story moves to stories/5-done/
(files changed/added, new public API, tests added, commit, reviewer notes). Do not hand-edit. -->
