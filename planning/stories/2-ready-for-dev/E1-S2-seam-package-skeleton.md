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

- `packages/analytics-kit/package.json`: name **exactly** `analytics-kit`, `version: 0.0.0`, the exports/main/module/types fields (see Technical notes), **no** `"type": "module"` (see Technical notes — tsup's output extensions depend on its absence), and the per-package scripts `typecheck` (`tsc --noEmit`), `lint` (`eslint .`), `test` (`vitest run`), `build` (`tsup`). No `dependencies` on any target and no vendor SDK dependency.
- `packages/analytics-kit/tsconfig.json` extending `../../tsconfig.base.json` (`rootDir: src`, `outDir: dist`).
- `packages/analytics-kit/tsup.config.ts` (extends/inlines the shared tsup convention: `entry: ['src/index.ts']`, `format: ['esm','cjs']`, `dts: true`, `clean: true`, `sourcemap: true`).
- `packages/analytics-kit/vitest.config.ts` — merges the root `vitest.shared.ts` base (S1) via `mergeConfig`, so `passWithNoTests: true` reaches this package's `vitest run` (vitest resolves config from the CWD and does not walk up). No tests yet; the config just carries the shared settings until S4 adds the trivial test.
- `packages/analytics-kit/src/index.ts` — a **neutral** placeholder export only (e.g. `export const version = '0.0.0'` or `export {}`). No provider/adapter/taxonomy surface.

### Out

- The `AnalyticsProvider` contract, config-selected factory, and no-op adapter — those are **E2**.
- Typed-taxonomy + allowlist mechanisms — those are **E3**.
- The three target packages (S3).
- The trivial passing test (S4) — this story's `vitest.config.ts` surfaces the shared `passWithNoTests: true` to `vitest run`, keeping this package's `test` gate green until S4 adds the test.

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
- **No `"type": "module"` (load-bearing)** — the exports map above points `import` → `./dist/index.mjs` and `require` → `./dist/index.js`. tsup's default output extensions are `cjs → .js`, `esm → .mjs` **only when the package.json has no `"type": "module"`**; adding `"type": "module"` flips them to `esm → .js`, `cjs → .cjs`, leaving the exports map pointing at files tsup never emits (and breaking S4's `.mjs`+`.js` output AC). Do NOT set `"type": "module"` on this package. The same constraint applies to all three targets (S3).
- **vitest / eslint / tooling reach (— architect 2026-07-07)** — this package ships its own `vitest.config.ts` merging the root `vitest.shared.ts` (S1); it is the only way `passWithNoTests: true` reaches a per-package `vitest run` (vitest does not walk up for config). `eslint .`, `tsc`, and `tsup` need no per-package config beyond what's listed: the root flat config (with its `dist`/`.turbo` ignores) and the root-only dev tooling resolve from this package's CWD via node's upward `node_modules` walk. So the "no dependencies" AC below means no *runtime/workspace* deps — the package still carries no build/test devDeps of its own for E1.
- **Dependency direction (locked, epic Notes 2026-07-07)** — inward-only. The seam depends on **no** target; targets depend on it (S3). posthog precedent: `@posthog/core` depends on no browser/node package while `posthog-node` depends on `@posthog/core` (`workspace:^`).
- **Package name (locked)** — the seam is the bare `analytics-kit` (the main entry), not `@analytics-kit/core`; no package is literally named `core`. Scoped `@analytics-kit/*` names are for targets only (S3).
- **tsconfig** — extend the root `tsconfig.base.json` from S1; only override `rootDir`/`outDir`. No DOM lib here (the seam is isomorphic).
- Keep `src/index.ts` a genuine placeholder — real seam surface lands in E2/E3. Do not pre-stub provider/adapter types here.

## Shipped

<!-- Empty at draft. /implement-epics fills this once, when the story moves to stories/5-done/
(files changed/added, new public API, tests added, commit, reviewer notes). Do not hand-edit. -->
