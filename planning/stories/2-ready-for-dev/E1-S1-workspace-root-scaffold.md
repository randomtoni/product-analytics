---
id: E1-S1-workspace-root-scaffold
epic: E1-CORE-workspace-scaffold
status: ready-for-dev
area: core
touches: []
depends_on: []
api_impact: additive
---

# E1-S1-workspace-root-scaffold — Workspace root & shared toolchain config

## Why

The workspace root is the substrate every package plugs into: without the pnpm workspace, the turbo four-task graph, and the shared root config (tsconfig base / eslint flat / vitest / tsup), no package can build or be gated. This slice ships the root config only — zero packages yet.

## Scope

### In

- `pnpm-workspace.yaml` declaring `packages/*` (nothing else this release; no `examples/` glob until E10).
- Root `package.json`: `private: true`, `packageManager` pinned to `pnpm@11.x`, `engines.node`, the shared devDependencies (turbo, typescript, tsup, vitest, eslint + flat-config TS plugins), and the four gate scripts, each delegating to turbo: `typecheck` → `turbo run typecheck`, `lint` → `turbo run lint`, `test` → `turbo run test`, `build` → `turbo run build`.
- `turbo.json` with exactly the four-task graph:
  - `build` — `dependsOn: ["^build"]`, `outputs: ["dist/**"]`, `inputs: ["src/**", "tsconfig.json", "tsup.config.ts", "package.json"]` (posthog's `build.inputs` de-branded: drop the babel/rollup/rslib/vite entries, keep the tsup-relevant ones)
  - `typecheck` — `dependsOn: ["^build"]`
  - `test` — `dependsOn: ["^build"]`
  - `lint` — `{}` (no dependsOn)
  - top-level `globalDependencies: ["tsconfig.base.json", "eslint.config.js", "vitest.shared.ts"]` (+ a root tsup base if authored as a root file) — editing a shared root config busts every package's cache. Deliberately broad (a lint-config edit also busts build/test caches); correctness over cache-optimality for the scaffold. This is a top-level key, not a fifth task — the graph is still exactly the four tasks above.
- Root shared config the packages extend:
  - `tsconfig.base.json` (strict, `target: ES2022`, `module`/`moduleResolution` node-compatible, `declaration: true`, `isolatedModules: true`, `esModuleInterop`, `skipLibCheck`).
  - `eslint.config.js` — eslint **flat** config, TS parser + base ruleset, plus a global-ignores block `{ ignores: ['**/dist/**', '**/.turbo/**'] }` (node_modules is default-ignored in flat config; `dist` is NOT — without this the per-package `eslint .` fails the moment `dist/` exists after a build).
  - a shared vitest config: a root `vitest.shared.ts` base module exporting the shared config (`passWithNoTests: true`), which each package's own `vitest.config.ts` (S2/S3) merges via `mergeConfig`. A per-package config file is required because vitest resolves config from the CWD only and does **not** walk up — a root-only config would never reach a package's `vitest run`. The per-package config also holds the env slot (`node` default; `jsdom` for browser later, E4+).
  - a shared tsup config convention packages extend (`format: ['esm','cjs']`, `dts: true`).
- `.gitignore` entries for `dist/`, `node_modules/`, `.turbo/` as needed.

### Out

- Any package skeleton — the seam (S2) and the targets (S3).
- Any `src/` code, provider contract, adapter, or taxonomy logic (E2/E3).
- Per-package `tsup.config` / `tsconfig` / `package.json` (S2, S3).
- CI pipeline config (infra; deferred per epic Out-of-scope).

## Acceptance criteria

- [ ] `pnpm install` at the root resolves the (package-less) workspace with no errors.
- [ ] `turbo run typecheck`, `turbo run lint`, `turbo run test`, `turbo run build` each exit 0 (a no-op "no tasks to run" is acceptable with zero packages present).
- [ ] `turbo.json` defines exactly the four tasks `build` / `typecheck` / `test` / `lint` with the dependency edges above; no vendor-specific tasks (`package`, `prepublish`, `generate-references`) carried over.
- [ ] Root `package.json` exposes the four gate scripts, all delegating to `turbo run <task>`.
- [ ] `tsconfig.base.json`, flat `eslint.config.js`, and the shared vitest + tsup conventions exist and parse.
- [ ] Zero vendor references (`posthog`/vendor names) in any root file name, config key, or value (`grep -ri posthog` clean).

## Technical notes

- Toolchain is locked (epic Notes, 2026-07-07): pnpm workspace · turbo · vitest · tsup · tsc `--noEmit` · eslint flat config. Not open for re-litigation.
- **turbo.json** — mirror the shape of `posthog-js/turbo.json` (its `build.dependsOn: ["^build"]` + `outputs: ["dist/**"]` is the direct precedent), **de-branded**: drop PostHog-only tasks (`package`, `prepublish`, `generate-references`, `posthog-js#...` overrides). Gate task names are fixed by CLAUDE.md: `typecheck` (not posthog's `check-types`), `lint`, `test`, `build`. `^build` on `typecheck`/`test`/`build` is forward-looking: once targets import the seam's built `.d.ts`/JS (E2+), the upstream package must build first; encode it now.
- **packageManager / engines** — `posthog-js/package.json` pins `pnpm@11.7.0` + node `24.x`; mirror `pnpm@11.x`, and set a broad `engines.node` (`>=20`) — we carry no react-native package, so no need for posthog's exact node pin.
- **tsconfig.base.json** — mirror the compiler-option shape of `posthog-js/packages/core/tsconfig.json` (`target: ES2022`, `isolatedModules`, `declaration`), but as a **root base file** packages extend, not a workspace tooling package. posthog uses `@posthog-tooling/tsconfig-base` (`workspace:*`); the epic's Stories bullet specifies a root shared config instead — simpler, no extra tooling package. Do NOT add DOM lib at the base; targets add their own lib as needed (E4+).
- **tsup** — our locked build tool; `format: ['esm','cjs']`, `dts: true`, `entry: ['src/index.ts']`, `clean: true`, `sourcemap: true`. posthog-js builds with **rslib/vite, not tsup** — do NOT copy posthog's build config; author the tsup config from CLAUDE.md's spec.
- **eslint flat config** — `eslint.config.js` (eslint 9 flat). This deliberately deviates from `posthog-js`, which still uses legacy `.eslintrc` on eslint 8.57 — do NOT copy posthog's eslint setup.
- **vitest** — not jest (posthog uses jest). Set `passWithNoTests: true` in the shared `vitest.shared.ts` base so S2/S3's test-less scaffold packages stay green before S4 adds the trivial tests. CLAUDE.md's optional `pool: 'threads'` + `isolate: false` is a perf tweak, not required for scaffold.
- **Per-package gate-script config resolution (— architect 2026-07-07)** — shared dev tooling (turbo/typescript/tsup/vitest/eslint) stays **root-only** in the root `package.json` devDeps; it resolves from each package's CWD via node's upward `node_modules` walk (bins on PATH) and module resolution (config-file imports like `import { defineConfig } from 'tsup'` / `'vitest/config'`). pnpm strict isolation only withholds a package's *undeclared transitive* deps, not a workspace root's *direct* devDeps — so the skeleton packages need **no** build/test devDeps of their own for E1 (posthog proves it: `typescript`/`eslint`/`turbo` are root-only there yet run per-package). Two asymmetries this creates, both handled above: (1) **eslint** flat config walks up from CWD, so one root `eslint.config.js` covers every package via `eslint .`; (2) **vitest** does NOT walk up, so each package needs its own `vitest.config.ts` merging the root base. Forward-looking (NOT E1): when browser's vitest config sets `environment: 'jsdom'` (E4+) vitest must resolve `jsdom` at runtime — that's when vitest (and optionally tsup) move to per-package devDeps (via a pnpm `catalog:`), the way posthog pushes `jest`/`@rslib/core` down per-package.

## Shipped

<!-- Empty at draft. /implement-epics fills this once, when the story moves to stories/5-done/
(files changed/added, new public API, tests added, commit, reviewer notes). Do not hand-edit. -->
