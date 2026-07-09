---
id: E9-S1-react-package-scaffold
epic: E9-RCT-react-binding
status: ready-for-dev
area: react
touches: [react]
depends_on: []
api_impact: additive
---

# E9-S1-react-package-scaffold — `@analytics-kit/react` package scaffold + React test infra

## Why

The `@analytics-kit/react` package is a bare stub (`index.ts` = `version`, `index.test.ts`). Before any provider/hook code can land, the package needs its React/JSX build + test infrastructure: `react` and `@analytics-kit/browser` as peer dependencies, JSX in the tsconfig, and a jsdom + `@testing-library/react` harness. This is the foundation the other three stories build on.

## Scope

### In

- `packages/react/package.json`: declare **peer dependencies** `react` (`>=18`, already present) **and `@analytics-kit/browser` (`workspace:*` peer)** — the browser target is the inward *runtime construction* path (epic Notes: dependencies point inward, `react → browser → seam`), and pinning it as a peer keeps a **single shared client instance** with the consumer controlling the version. **Keep the existing `analytics-kit` (seam) `workspace:*` dependency** (currently declared — do NOT remove it): react needs the seam for the *type* surface (`RootAnalytics` / `AnalyticsConfig` / `ScopedAnalytics` / the taxonomy types `ShapeOf` / `TaxonomyShape` / `DefaultTaxonomyShape`), which originate in `analytics-kit` and are **NOT re-exported from `@analytics-kit/browser`** (verified: browser `index.ts` re-exports only `AnalyticsProvider`/`RootAnalytics`/`ScopedAnalytics`/`AnalyticsConfig`/`CaptureProfile` — no taxonomy types). So react depends on **two** packages, each for a distinct reason: the **seam** (regular dep) for the neutral type contract, the **browser target** (peer dep) for the runtime `createAnalytics` factory. This is architecturally correct — the hook types couple to the seam contract, the construction path couples to the target (architect 2026-07-08).
- Add **devDependencies** for the React toolchain + test harness: `react`, `react-dom`, `@testing-library/react`, `@testing-library/dom`, and `jsdom` (mirrors browser's `jsdom` devDep). Add `@types/react` / `@types/react-dom` as devDeps for typing. `@analytics-kit/browser` also as a devDependency (`workspace:*`) so tests can construct a real client. (A peer dep is not installed into the package's own `node_modules` for tests — the matching devDep provides it, exactly as posthog-js react pairs `posthog-js` peerDep + devDep.)
- `packages/react/tsconfig.json`: add `"jsx": "react-jsx"` to `compilerOptions` (the automatic runtime — no per-file `import React`), and `"lib": ["ES2022", "DOM"]` (React types need DOM lib; browser's tsconfig sets the same). Keep `extends: ../../tsconfig.base.json`, `rootDir: src`, `outDir: dist`.
- `packages/react/vitest.config.ts`: set `test.environment: 'jsdom'` — the stub is currently `mergeConfig(shared, defineConfig({}))` (empty merge); replace the empty `defineConfig({})` with `defineConfig({ test: { environment: 'jsdom' } })`, mirroring `packages/browser/vitest.config.ts` verbatim.
- `packages/react/tsup.config.ts`: confirm it emits ESM+CJS+`.d.ts` for a package with JSX/TSX sources. The base config (`tsup.config.base.ts`: `entry: ['src/index.ts'], format: ['esm','cjs'], dts: true, clean, sourcemap`) is esbuild-based and transpiles `.tsx` natively via the entry glob — **no jsx override is expected to be needed** (esbuild infers JSX from the `.tsx` extension). Keep the current `defineConfig({ ...baseTsupConfig })` unless the build actually fails on JSX; only then add `esbuildOptions.jsx: 'automatic'`. Entry stays `src/index.ts`. Mark `react`/`react-dom` `external` only if tsup starts bundling them (it should treat peer deps as external by default — verify the emitted bundle does not inline React).
- A minimal smoke test proving the harness works: render a trivial component (or the existing `version` export test kept) with `@testing-library/react` under jsdom and assert it mounts. This validates jsx + jsdom + testing-library end-to-end before real provider code lands.
- Keep `src/index.ts` exporting `version` for now; S2–S4 add the real exports.

### Out

- The `AnalyticsClientProvider` component, `useAnalytics()`, and `usePageView()` — those are S2/S3/S4. This story only lands infra + a smoke test.
- Any change to other packages' configs or to root `package.json` devDeps beyond what the react package needs (add react toolchain devDeps to the **react package**, not the root, matching how browser holds its own `jsdom`).

## Acceptance criteria

- [ ] `pnpm --filter @analytics-kit/react typecheck` passes with `jsx: react-jsx` set and a `.tsx` file present (add a throwaway `.tsx` in the smoke test to exercise it, or the S2 component later — at minimum the tsconfig compiles JSX).
- [ ] `react` and `@analytics-kit/browser` are **peer dependencies** (not hard runtime `dependencies`) in `packages/react/package.json`; both also present as devDeps so tests resolve them. `analytics-kit` (seam) remains a regular `dependency` (the type surface + taxonomy types live there, unre-exported by browser).
- [ ] A `@testing-library/react` render test runs green under vitest's jsdom environment (`pnpm --filter @analytics-kit/react test`).
- [ ] All four gates green for the react package: `typecheck`, `lint`, `test`, `build` (build emits ESM + CJS + `.d.ts`).
- [ ] Zero vendor references in package name, config, or file names (bar B / commitment).

## Technical notes

- **Peer-dep shape** — epic Notes (architect 2026-07-07): the `config`-path construction is inward via `@analytics-kit/browser`'s public factory (`createAnalytics`), never by importing an adapter into the seam. So `@analytics-kit/browser` is a **peer dependency** (single shared client instance, consumer-controlled version), mirroring posthog-js react's `posthog-js` peerDep + devDep pairing (`posthog-js/packages/react/package.json` `peerDependencies` + `devDependencies`). `react` stays a peer (`>=18`, already declared).
- **Two deps, two reasons (do NOT collapse to one)** — architect 2026-07-08: react depends on BOTH `analytics-kit` (seam, regular dep — already present) and `@analytics-kit/browser` (target, peer dep — S1 adds it). The seam supplies the *type* contract the hooks name (`RootAnalytics`/`AnalyticsConfig`/`ScopedAnalytics` + taxonomy types `ShapeOf`/`TaxonomyShape`/`DefaultTaxonomyShape`); the browser target supplies the *runtime* `createAnalytics` factory the `config`-path construction calls (S2). The earlier "depend on one target, not two" framing was wrong: browser does NOT re-export the taxonomy types (verified `packages/browser/src/index.ts` — only `AnalyticsProvider`/`RootAnalytics`/`ScopedAnalytics`/`AnalyticsConfig`/`CaptureProfile`), so a react hook that types `useAnalytics<TX>` needs the seam directly. Coupling the hook types to the seam contract (not routing them through a platform target) is also architecturally correct — a future non-browser target binding reuses the same seam-typed hook.
- **`pnpm install` required** — adding peer + devDeps (`react-dom`, `@testing-library/react`, `@testing-library/dom`, `@types/react`, `@types/react-dom`, `jsdom`, `@analytics-kit/browser` peer+dev) means the builder runs `pnpm install` at the repo root before the gates resolve. `@analytics-kit/browser`'s workspace link must appear in react's `node_modules` (currently only `analytics-kit` + `react` are linked there).
- **JSX config** — use `jsx: "react-jsx"` (automatic runtime) so components don't need `import React`. Add `"DOM"` to `lib` (React JSX types + `@testing-library/react` require it). Reference: browser `tsconfig.json` sets `lib: ["ES2022", "DOM"]`.
- **Test infra** — vitest `environment: 'jsdom'` (browser package's `vitest.config.ts` is the precedent). `@testing-library/react` for render/act; jsdom provides the DOM. posthog-js react uses `@testing-library/react` + jsdom (jest) — same harness, different runner.
- **No `catalog:`** in this workspace (`pnpm-workspace.yaml` has no catalog) — declare devDep versions directly (e.g. `react`/`react-dom` `^18` or `^19`; `@testing-library/react` `^16`; `jsdom` matching browser's `^26`). Builder picks concrete versions.
- **De-brands** — the package scaffold itself (posthog-js `packages/react` package.json / tsconfig / jest as the shape reference); no runtime source de-branded in this story.
- **Frozen-15 discipline** carries into S2–S4, not here: the react binding EXPOSES the facade, adds no facade verbs (`keyof AnalyticsProvider` pinned at 15 in `analytics-kit`'s `analytics-provider.test.ts`).

## Shipped
