---
id: E1-S3-target-package-skeletons
epic: E1-CORE-workspace-scaffold
status: ready-for-dev
area: core
touches: [browser, node, react]
depends_on: [E1-S2-seam-package-skeleton]
api_impact: additive
---

# E1-S3-target-package-skeletons — Target package skeletons (`@analytics-kit/{browser,node,react}`)

## Why

The three targets are where platform specifics land in later cycles; scaffolding them now — each depending **inward** on the seam and never sideways — makes the load-bearing dependency direction a structural fact from day one, so E4+ inherit it for free.

## Scope

### In

- `packages/browser/package.json` — name `@analytics-kit/browser`, `dependencies: { "analytics-kit": "workspace:*" }`.
- `packages/node/package.json` — name `@analytics-kit/node`, `dependencies: { "analytics-kit": "workspace:*" }`.
- `packages/react/package.json` — name `@analytics-kit/react`, `dependencies: { "analytics-kit": "workspace:*" }`, plus **`peerDependencies: { "react": ">=18" }`** (react is a peer, not a runtime dep).
- Each target: the same per-package scripts as the seam (`typecheck`/`lint`/`test`/`build`), a `tsconfig.json` extending `../../tsconfig.base.json`, a `tsup.config.ts` (shared convention, incl. `sourcemap: true`), a `vitest.config.ts` merging the root `vitest.shared.ts` (so `passWithNoTests` reaches `vitest run` — same mechanism as the seam, S2), the exports/main/module/types triplet **matching the seam's exact shape** (S2: `import`→`./dist/index.mjs`, `require`→`./dist/index.js`, `types`→`./dist/index.d.ts`), **no** `"type": "module"` on any target, and a **neutral** placeholder `src/index.ts`.

### Out

- Any identity, persistence, transport, capture, enrichment, server-capture, query, or React-binding logic — those are **E4–E9**.
- Any **target→target** dependency (forbidden: browser must not depend on node, etc.).
- Any vendor SDK dependency (copy-don't-wrap; nothing to copy yet).
- The trivial passing tests + full end-to-end gate sweep (S4).

## Acceptance criteria

- [ ] Each of `@analytics-kit/browser`, `@analytics-kit/node`, `@analytics-kit/react` builds via tsup to `dist` (ESM `.mjs` + CJS `.js` + `.d.ts`).
- [ ] Each target declares `analytics-kit` as its **only** workspace dependency; no `@analytics-kit/*` target depends on another target.
- [ ] `@analytics-kit/react` declares `react` under `peerDependencies`, not `dependencies`.
- [ ] `turbo run build` builds `analytics-kit` **before** the targets (topo order via `^build`).
- [ ] `typecheck` / `lint` / `test` exit 0 for each target (test green via `passWithNoTests` until S4).
- [ ] Package names are the exact locked scoped names; `grep -ri posthog packages/{browser,node,react}` is clean; no file or config names a vendor.

## Technical notes

- **Package names (locked, epic Notes 2026-07-07)** — targets are `@analytics-kit/{browser,node,react}`; the seam they depend on is the bare `analytics-kit`. Mirrors the split in BRIEF §Packages.
- **Inward-only direction (locked)** — `analytics-kit` ← each target, never sideways, never outward. Encode via `"analytics-kit": "workspace:*"`. posthog precedent: `posthog-node` → `@posthog/core` (`workspace:^`), with no node↔browser edge. Adapters (E5+) will be **internal modules** of a target, named by role, never by vendor (`posthogAdapter` is invalid).
- **react as a peer** — `@analytics-kit/react` is an optional binding (BRIEF §Agnostic design rules); react/react-dom belong in `peerDependencies` so the consumer owns the react version. E9 fills in the provider + hooks; this story ships only the empty package. `posthog-js/packages/react` is the de-brandable reference for the eventual binding shape.
- **tsup / tsconfig** — reuse the shared conventions from S1 exactly (`format: ['esm','cjs']`, `dts: true`, `sourcemap: true`). `@analytics-kit/browser` may set `lib: ["ES2022","DOM"]` in its tsconfig later (E4); not required for an empty skeleton. Do not copy posthog's rslib/vite build config.
- **No `"type": "module"` (load-bearing, same as S2)** — each target's exports map points `import` → `./dist/index.mjs`, `require` → `./dist/index.js`; tsup only emits those extensions when the package has no `"type": "module"`. Do NOT set it on browser, node, or react — otherwise the extensions flip and the exports map (and S4's `.mjs`+`.js` AC) break.
- **`^build` order comes from the workspace dep graph, not imports** — turbo derives the `analytics-kit`-before-targets ordering from each target's `"analytics-kit": "workspace:*"` dependency, NOT from any import in `src/index.ts`. The placeholder `src/index.ts` stays import-free (no cross-target, and it need not import the seam either); the AC "build `analytics-kit` before the targets" holds purely from the declared workspace dep. Do NOT add a bogus seam import to "make ordering work."
- **vitest / eslint / tooling reach (same as S2, — architect 2026-07-07)** — each target ships its own `vitest.config.ts` merging the root base (vitest doesn't walk up); `eslint .` is covered by the root flat config's `dist`/`.turbo` ignores (S1); root-only dev tooling resolves from each target's CWD via the upward `node_modules` walk — targets carry no build/test devDeps of their own for E1 (only the `analytics-kit` workspace dep, plus react's `react` peer).
- Keep each `src/index.ts` a neutral placeholder — no platform logic, no cross-target imports.

## Shipped

<!-- Empty at draft. /implement-epics fills this once, when the story moves to stories/5-done/
(files changed/added, new public API, tests added, commit, reviewer notes). Do not hand-edit. -->
