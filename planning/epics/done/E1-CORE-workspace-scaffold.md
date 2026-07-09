---
id: E1-CORE-workspace-scaffold
status: done
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

Linear chain — `S1 → S2 → S3 → S4` (each depends on the prior); topo-sortable via `depends_on`. S2 (seam) lands before S3 (targets) so the inward-only dependency direction is a checkable story boundary. **All four shipped.**

- **[E1-S1](../stories/5-done/E1-S1-workspace-root-scaffold.md)** *(done — `30c684a`)* — workspace root: `pnpm-workspace.yaml` + `turbo.json` four-task graph + root shared config (`tsconfig.base.json`, flat `eslint.config.js`, shared vitest + tsup conventions).
- **[E1-S2](../stories/5-done/E1-S2-seam-package-skeleton.md)** *(done — `a804f86`)* — the seam package `analytics-kit` skeleton: `package.json` (exports triplet, per-package gate scripts, no inward/outward deps), `tsconfig`, `tsup.config`, neutral placeholder `src/index.ts`. Root of the inward graph.
- **[E1-S3](../stories/5-done/E1-S3-target-package-skeletons.md)** *(done — `fa2c7d5`)* — the three target skeletons `@analytics-kit/{browser,node,react}`, each depending inward on `analytics-kit` (`workspace:*`), never sideways; react declares `react` as a peer.
- **[E1-S4](../stories/5-done/E1-S4-gates-green-end-to-end.md)** *(done — `a08093b`)* — gates green end-to-end: a trivial passing test per package + `turbo run typecheck|lint|test|build` all green across all four packages, `FULL TURBO` cache on re-run.

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
