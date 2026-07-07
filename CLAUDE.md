# analytics-kit

App-agnostic, **vendor-neutral analytics abstraction library** in **TypeScript**. Consuming apps
depend on it like a vendored SDK and code against its own neutral interfaces — never a vendor SDK
directly. The first backend target is a PostHog-compatible one, implemented by **copying only the
posthog-js client code we need and de-branding it — never importing a vendor SDK**; a self-hosted
target drops in later. The library
mirrors posthog-js's `core → browser → node` structure — but **its own surface names no vendor**
(see Product commitments).

## Product commitments (the north star)

Every design decision is measured against these:

- **Vendor-neutral seam.** The backend sits behind an adapter; no vendor type ever leaks to
  consumers.
- **No vendor references in the library.** `posthog-js` is only an external reference we *adapt
  from* — the library's own code, public API, type names, package names, and docs carry **zero
  `posthog`/vendor references**. Code copied from posthog-js is neutralized: PostHog naming
  stripped, vendor endpoints become configuration. (`posthogAdapter` and the like are invalid —
  name by role, not by vendor.)
- **Capability-completeness.** The neutral surface must cover what a mature analytics SDK exposes
  (capture/events, identify, super-properties, groups, query primitives for KPIs — plus typed
  extension points for feature flags, session replay, …) — measured against the `posthog-js`
  reference — so nothing is lost by depending on this library. **Port only what's needed**: the
  capability set is scoped to the contract in `planning/BRIEF.md`, not to everything PostHog ships.
- **Two acceptance bars** — the hard test of any design:
  1. **Provider-swap = one adapter, zero consumer change.** Swapping the backend means writing ONE
     adapter and changing NO consumer code.
  2. **New-app adoption = config only, zero library change.** A new consuming app adopts by
     configuration alone — no edits to the library.
- **Primitives, not products.** Expose analytics primitives (capture an event, identify a user,
  run a funnel/retention query), not opinionated end-product features.
- **Privacy = a consumer-supplied payload allowlist.** The consumer supplies the allowlist of
  properties permitted to leave the app; the library enforces it.

## Architecture Reference

For questions about analytics capabilities, wire behavior, or the shape a neutral interface
should take, ground the answer in **PostHog's own open source**, cloned locally at the repo root:

```
posthog-js/            # PostHog/posthog-js monorepo — local reference checkout at its current HEAD (git-ignored)
├── packages/core      # @posthog/core — shared, lower-level surface
├── packages/browser   # the browser SDK: persistence, autocapture, pageviews, session replay
├── packages/node      # the Node/server SDK: server-side capture, no browser persistence
└── packages/react     # React bindings
```

There is no router file — navigate the packages directly. `packages/core` is the shared surface;
the browser/node/react packages are the platform specifics. The library's OWN vendor-neutral seam
does not exist yet — `posthog-js` is the reference for what capability-completeness looks like,
not a thing to copy shape-for-shape (the seam must stay neutral).

Three agents ground technical work:
- **`architect`** — the mentor and technical sounding-board. Ask it how things should be built or
  which path forward is right. It reasons from the codebase, engineering judgment, the analytics
  ecosystem, and the `posthog-js` source (its deepest reference).
- **`architect-reviewer`** — the auditor. It reviews proposed or written code against the
  vendor-neutral commitments and the `posthog-js` reference, and flags deviations.
- **`posthog-source-guide`** — the read-only PostHog-source reference. Consult it for *how PostHog
  actually implements X* (capture, flags, persistence, replay, batching) grounded in the
  `posthog-js/` checkout, and for which mechanics are PostHog-specific vs universal to the neutral
  seam. It informs `architect`/`builder`; it doesn't decide shape or write code.

## Validation Workflow

When the user asks to "consult the architect" / "ask the architect" — spawn the `architect` agent
with the question. When the user asks to "validate with the architect" / "review with the
architect" — spawn the `architect-reviewer` agent with the proposed or written code.

**Typical flow for non-trivial changes:**
1. Consult `architect` on approach → get design guidance
2. Propose implementation → user approves
3. Validate with `architect-reviewer` → check alignment before writing code
4. Implement → write the code
5. Review with `architect-reviewer` → verify the final result

This applies to architectural changes, not trivial fixes. Use your judgement.

## Project Structure

Greenfield — the workspace layout below is the intended shape (mirrors posthog-js), not yet built:

```
packages/
├── analytics-kit/   # the main entry & vendor-neutral seam: provider contract, adapter interface,
│                    #   typed-taxonomy mechanism, allowlist hook, config-selected factory, shared types
├── browser/         # @analytics-kit/browser — browser target: identity/persistence, transport,
│                    #   capture + enrichment (ported from posthog-js, de-branded)
├── node/            # @analytics-kit/node — server target: server-side capture + the query client
└── react/           # @analytics-kit/react — optional React/Next binding (provider + hooks)
```

Consumers install only the target they need. **Package names are decided**: the seam is the main
`analytics-kit` package (no package literally named `core` — "core" survives only as the area
slug), platform targets are `@analytics-kit/*`. Never bake a vendor name into any of them.
Adapters are internal modules of their target package, named by role, never by vendor.

## Conventions

- **Interface-first, vendor-neutral** — consumers depend on the library's own TypeScript
  interfaces; backends sit behind an adapter that satisfies them.
- **Structural typing** — TypeScript `interface`s for contracts; plain types for data, with a
  runtime-validation schema (e.g. Zod) only at genuine boundaries.
- **Isomorphic-aware** — shared logic in `core`; browser-only and node-only concerns stay in
  their target packages (mirrors posthog-js's split).
- **Adopt only what you need** — the package split lets a consumer pull in one target/adapter.
- **Tests** — unit-test against a mock/in-memory adapter; never hit a real analytics backend.

## Quality gates

Run all four after meaningful changes — the bar is **all green on all four**:

```
turbo run typecheck   # tsc --noEmit across packages
turbo run lint        # eslint
turbo run test        # vitest
turbo run build       # tsup → dist (esm + cjs + .d.ts) per package
```

(turbo caches these per package, so unchanged packages are skipped.)

**Package manager: `pnpm`** (locked). This is a workspace of packages (`core` / `browser` /
`node` / optional `react` + adapters), the exact shape pnpm workspaces are built for — strict
dependency isolation keeps a phantom dependency in one package from leaking into another, and it
matches the `posthog-js` reference (pnpm@11 + turbo). Use `pnpm` for all install/run/workspace
commands.

**Test runner: `vitest`** (locked). Faster than jest for a TS/ESM library — esbuild transform (no
per-file Babel/ts-jest transpile), native ESM, and a module-graph-aware watcher that re-runs only
the tests affected by a change instead of the whole suite (the fix for slow 1000+-test runs). Push
it further with `pool: 'threads'` + `isolate: false` where safe.

**Monorepo: `turbo`** (locked). The library is a workspace of packages (`core` / `browser` /
`node` / `react` + adapters); turbo caches each package's `build` / `test` / `typecheck` / `lint`
keyed by that package's inputs, so an unchanged package's tasks are skipped (and the cache is
shareable in CI) — you rebuild/retest only what actually changed. Define the task graph in
`turbo.json`; run gates via `turbo run <task>`.

**Build tool: `tsup`** (locked). esbuild-based; emits dual **ESM + CJS** plus `.d.ts` from a tiny
per-package config (`format: ['esm','cjs']`, `dts: true`). `tsc --noEmit` remains the typecheck
gate (esbuild doesn't typecheck), and `tsc` is what backs the `.d.ts` emit. **Lint: `eslint`**
(flat config). Full toolchain: **pnpm · turbo · vitest · tsup · tsc · eslint** — all locked; only
the individual config files remain to be written when code lands.
