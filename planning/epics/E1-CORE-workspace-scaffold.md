---
id: E1-CORE-workspace-scaffold
status: planned
area: core
touches: []
api_impact: additive
blocked_by: []
updated: 2026-07-07
---

# E1-CORE-workspace-scaffold — Workspace & toolchain scaffold

## Why

The workspace is the substrate every other epic builds on — nothing can be ported or de-branded until the pnpm + turbo workspace exists with the four packages and all four quality gates green. Encoding the inward-only dependency direction on day one is what keeps the vendor-neutral seam structurally enforceable as later epics land.

## Success criteria

- pnpm workspace + turbo; packages `analytics-kit` (the seam / main entry) + `@analytics-kit/{browser,node,react}` scaffolded (empty but building).
- All four gates green on the empty packages: `turbo run typecheck` (tsc `--noEmit`), `turbo run lint` (eslint flat config), `turbo run test` (vitest), `turbo run build` (tsup → esm + cjs + `.d.ts` per package).
- Dependency direction enforced: targets depend on the seam package; the seam package depends on no target; no sideways target→target dependency.
- No package literally named `core`; zero vendor reference in any package name, file name, or config.

## Stories

- Workspace root: `pnpm-workspace.yaml` + `turbo.json` task graph + root `tsconfig`/eslint-base/vitest/tsup shared config.
- The four package skeletons: each with `package.json` (name, `exports`, deps pointing inward), per-package `tsup.config` + `tsconfig`.
- Gates wired + green on empty packages: a trivial passing test per package so `test`/`typecheck`/`lint`/`build` all pass end-to-end.

## Out of scope

- Any provider / adapter / taxonomy logic (E2, E3).
- CI pipeline config (infra concern; the gates run locally via turbo, cache-shareable in CI later).
- Publishing / registry / versioning setup.

## Notes

- — architect (2026-07-07): Toolchain is locked — pnpm workspace · turbo · vitest · tsup · tsc `--noEmit` · eslint flat config. Not open for re-litigation.
- — architect (2026-07-07): Package split is decided — `analytics-kit` is the seam / main entry; targets are `@analytics-kit/{browser,node,react}`. No package literally named `core` ("core" survives only as the area slug).
- — architect (2026-07-07): Dependency direction is inward-only — targets (browser/node/react) → seam package, never sideways, never outward. Encode it from day one so later epics inherit it. Mirrors posthog-js's own `core ← browser` / `core ← node` direction (`packages/node/src/client.ts:125` extends `@posthog/core`; `packages/browser/src/posthog-core.ts:101-116` imports from `@posthog/core`).
- — architect (2026-07-07): Adapters are internal modules of their target package, named by role, never by vendor (`posthogAdapter` and the like are invalid).
- Confidence: high (E1 has no open design question).

## Expansion path

A new target or backend is added as a package / internal adapter module under the same inward-only rule and role-named convention — additive, no change to the seam package.
