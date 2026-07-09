---
id: E10-S1-fernly-scaffold-recording-adapter
epic: E10-CORE-example-consumer
status: ready-for-dev
area: core
touches: [example, adapters]
depends_on: []
api_impact: additive
---

# E10-S1-fernly-scaffold-recording-adapter — Scaffold examples/fernly + in-memory recording adapter (headless no-op)

## Why

Every other E10 slice adopts through one shared harness: the invented product **Fernly** under `examples/fernly/`, wired to an in-memory recording `AnalyticsAdapter`. This story stands up that harness — the workspace member, its type/test gates, the recording mock, and the unkeyed whole-stack no-op — so the rest of the epic just adds config + assertions on top. This IS the bar-B substrate: a new app enrolled by config, running against a mock adapter, never a real backend.

## Scope

### In

- Create `examples/fernly/` as a **real pnpm workspace member**: add `examples/*` to `pnpm-workspace.yaml`; a `package.json` (`name: @example/fernly`, `private: true`) depending on the four packages via `workspace:*` (`analytics-kit`, `@analytics-kit/browser`, `@analytics-kit/node`, `@analytics-kit/react`) plus the React/jsdom devDeps S8 needs (`react`, `react-dom`, `@testing-library/react`, `@testing-library/dom`, `jsdom`, `@types/react`, `@types/react-dom`); a `tsconfig.json` extending `../../tsconfig.base.json` with `jsx: "react-jsx"` + `lib: ["ES2022","DOM"]`; a `vitest.config.ts` mirroring `packages/react/vitest.config.ts` (`environment: 'jsdom'`). Expose ONLY `typecheck` + `test` scripts — **no `build`, no published output**. (`lint` optional; if added, no new machinery.)
- A **`RecordingAdapter`** in `examples/fernly/src/` implementing the seam's exported `AnalyticsAdapter` interface — an in-memory recorder that captures every neutral call (`capture`/`identify`/`group`/`register`/`reset`/…) into inspectable arrays, models a small anonymous→identified identity state machine (see Technical notes; S3 exercises it), and returns benign values for the read verbs (`getConsentState`, `getDistinctId`, `fetch`, `getPersistedProperty`, `getLibraryId/Version`, `getCustomUserAgent`).
- A `createFernlyAnalytics(...)`-style harness factory in `examples/fernly/src/` that adopts through the **seam** `createAnalytics(config, recordingAdapter, { generateUuid })` (the public second-param injection point) — NOT the browser package's single-arg `createAnalytics`.
- A headless **no-op** proof: constructing the harness with `key` unset yields a whole-stack no-op that records nothing (bar B — an unconfigured environment sends nothing). A vitest test asserts zero recorded calls after a `track`.

### Out

- The Fernly taxonomy + identity mapping (S2), cross-subdomain merge (S3), contexts (S4), allowlist assertion (S5), node capture (S6), query (S7), React wiring (S8). This story ships the scaffold + recording adapter + no-op only.
- Any real backend endpoint/key, real cookies, or `BrowserAdapter` instantiation. The harness is seam + mock only.
- Any edit under `packages/**`. This story touches `examples/**` and `pnpm-workspace.yaml` only.

## Acceptance criteria

- [ ] `examples/fernly` is a pnpm workspace member (`examples/*` in `pnpm-workspace.yaml`); `pnpm install` resolves the four `workspace:*` deps.
- [ ] `turbo run typecheck` type-checks `examples/fernly` against the real packages' built `dist/*.d.ts` (no tsconfig path alias to any `packages/*/src`) and passes.
- [ ] `RecordingAdapter` implements the exported `AnalyticsAdapter` interface with zero `packages/*` edits; every write verb records into inspectable in-memory state.
- [ ] Unkeyed harness records nothing on `track` — a vitest test asserts an empty recording (bar B no-op).
- [ ] `turbo run test` runs `examples/fernly`'s vitest suite and passes.
- [ ] The E10 changeset for this story touches only `examples/**` and `pnpm-workspace.yaml` — nothing under `packages/**` (bar B: zero library change). Verifiable by diff.

## Technical notes

- **Harness shape = architect-ruled (2026-07-08), shape (A).** The whole harness adopts at the **seam** `createAnalytics(config, recordingAdapter, deps?)` — its second param is a public, shipped, injectable `AnalyticsAdapter` (`packages/analytics-kit/src/create-analytics.ts`), so injecting a mock is config-level adoption, not a library edit. The browser package's own `createAnalytics(config)` is single-arg and builds a real `BrowserAdapter`; E10 deliberately does NOT use it, so a mock can be injected. This is why "the browser slice is wired" (S8) is satisfied by the React binding + the neutral facade exercising the browser-relevant config surface (`cookieDomain`/`contexts`/`autocapture`), not by instantiating `BrowserAdapter`.
- **Why a mock adapter is the bar-B proof, not an integration test.** — epic (2026-07-07): the harness runs against a mock/in-memory adapter, never a real backend, and THAT is what makes it bar B. The facade (`AnalyticsProviderImpl`) owns the allowlist gate, consent swap, `register`/super-props, `context()` scoped views, and `buildEvent` (dedupeId mint) — all run against ANY adapter, so a recording mock exercises them faithfully.
- **RecordingAdapter identity state machine (feeds S3).** — architect (2026-07-08): to keep the merge proof honest, `identify()` must model the three-branch neutral contract, not just store the last id: (1) new id while modeled-anonymous → merge (retain prior anon id as the link, adopt new id, flip to identified); (2) same id → traits-only, no re-merge; (3) new id while already-identified → no client merge. `reset()` must re-anonymize (fresh anon id, drop the retained link, back to anonymous). `getDistinctId()` returns the current modeled id. This is ~15 lines of in-memory state — it models the neutral contract, NOT `BrowserAdapter`'s cookie/`IdentityStore` internals (E4 owns those). Ship the state machine here so S3 can assert on it.
- **Interface to implement:** `AnalyticsAdapter` in `packages/analytics-kit/src/adapter.ts` (exported from `analytics-kit`). Read it for the exact verb set and the read-verb return contracts (`getConsentState()` benign default, `fetch()` returns a `{status:0,…}` stub, etc. — mirror `NoopAdapter` for the inert reads).
- **Workspace/gate shape = architect-ruled (2026-07-08), shape (a).** Expose `typecheck` + `test`, omit `build`. `turbo run typecheck`/`test` `dependsOn: ["^build"]`, so the example is checked against freshly-built package `dist` — the exact surface an external npm consumer sees. Editing `pnpm-workspace.yaml` is repo-infra, NOT a bar-B violation (bar B scopes "library change" to `packages/*` source). The invariant to hold across all E10 stories: Fernly's own source edits zero `packages/*` files.
- **Naming (locked, load-bearing):** Fernly is invented and neutral — no real product/company. Fernly names appear ONLY under `examples/`; E11's name-scan is anchored to `packages/**` and explicitly excludes `examples/**`. Use a neutral package name (`@example/fernly` or similar) — never bake a vendor name anywhere.

## Shipped
