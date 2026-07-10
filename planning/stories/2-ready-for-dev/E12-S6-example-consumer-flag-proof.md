---
id: E12-S6-example-consumer-flag-proof
epic: E12-FF-flag-substrate-remote-eval
status: ready-for-dev
area: feature-flags
touches: [browser, node, react]
depends_on: [E12-S2, E12-S3, E12-S4, E12-S5]
api_impact: additive
---

# E12-S6-example-consumer-flag-proof — Example-consumer flag proof (Fernly TS + Quillstream Python)

## Why

The acceptance bars are only real once an example consumer exercises the port end-to-end by config alone. Fernly (TS) + Quillstream (Python) prove flags work through the neutral surface: config-supplied bootstrap (bar B), `evaluate` + typed payload reads, `onChange`, AND a bar-A swap to a mock flag adapter with zero consumer change. This is the epic's re-convergence point where both trees re-verify against the same behavior matrix.

## Scope

### In

- **Fernly (TS) flag exercise (`ts/examples/fernly/src/`)** — extend the example consumer to use flags by config alone:
  - Declare a `flags` slot in Fernly's typed taxonomy (`taxonomy.ts`) — at least one flag with `variants` + a typed `payload`.
  - Supply `config.flags.bootstrap` and prove a bootstrap-seeded sync read before the (mocked) fetch resolves.
  - Exercise `evaluate` + typed `getPayload`/`getFlag` reads (narrowing verified) + `onChange` re-fire on refresh.
  - Exercise the React flag hook (`useFeatureFlags`) in Fernly's React surface (S5) — re-render on flag arrival.
  - **Bar-A proof test:** swap the flag adapter to a mock/in-memory flag adapter (satisfying `FeatureFlagPort`) with ZERO change to Fernly's consumer code — the same `useFeatureFlags`/`evaluate` calls resolve against the mock. Mirror the existing `bar-a-adapter-swap.test.ts` pattern.
  - **Bar-B proof test:** config-only bootstrap + config-only adapter selection — no Fernly library edit. Mirror `bar-b-config-only.test.ts`.
- **Quillstream (Python) flag exercise (`python/examples/quillstream/`)** — the server-shaped analog:
  - Declare a `flags` slot in Quillstream's taxonomy (`src/quillstream/taxonomy.py`); supply `config.flags.bootstrap` (`src/quillstream/config.py`).
  - Exercise `evaluate(context={distinct_id})` (a plain SYNC call — no `await`, per S1/S4's locked Python-sync `evaluate`) + `get_payload`/`get_flag`/`get_all` reads + `on_change` once-fire.
  - Prove `distinct_id`-required validation (the server asymmetry) surfaces cleanly.
  - **Bar-A proof:** swap to a mock flag adapter (a fake satisfying `FeatureFlagPort`), zero consumer change. **Quillstream has NO existing `bar-A` adapter-swap test file** (verified: its tests are `test_bar_b_import_audit.py`, `test_query_exercise.py`, `test_server_capture.py`, `test_framework_binding.py`, etc. — no `bar_a`/`adapter_swap` test). Mirror instead the mock-satisfies-the-Protocol pattern `test_query_exercise.py` uses (a recording transport satisfying `QueryTransport`, `test_query_exercise.py:59`): a fake flag adapter satisfying the `FeatureFlagPort` Protocol, swapped in with byte-identical consumer code. Add a new `test_flag_exercise.py` (per-capability test file, matching the Quillstream convention) — do NOT claim to extend a bar-A file that does not exist.
  - **Bar-B proof:** config-only bootstrap + adapter selection, no library edit. Quillstream's bar-B surface is `test_bar_b_import_audit.py` (a public-import audit, NOT a config-only-bootstrap test) — the flag bar-B is proven by the new flag-exercise test using only public `analytics_kit` imports + config, so the existing import-audit stays green and the flag config-only path is exercised in the flag test. Do NOT assume a `bar-b-config-only`-named test analog exists.
- **Capability-presence / parity check** — record feature-flags as present in BOTH trees (remote eval). Fernly carries a frozen dist-level type-test `capability-presence.ts` (the `Equals<keyof …, Frozen…Members>` tripwire) + a runtime companion `capability-presence.test.ts` — extend those to record the flag capability's PRESENCE + SHAPE on the built exports. **Two node-specific facts to honor when extending it:** (1) the node flag client is exported as a standalone `createFlagClient` (S3) — assert its PRESENCE like `createQueryClient`, NOT as a `NodeAnalytics` member (the `FrozenNodeMembers` union at `capability-presence.ts:57` MUST stay `capture`/`setTraits`/`setGroupTraits`/`flush`/`shutdown` — adding `flags` there is a false break); (2) the browser/seam `flags?` slot presence is already covered by `FrozenProviderMembers` — do not re-pin it, just assert the `FeatureFlagPort` export + the flag-client factory export. **Pin the port's own member surface the way query is pinned** (S1 decided this shape): a Layer-1 `flagPortKeys: Equals<keyof FeatureFlagPort<DefaultTaxonomyShape>, FrozenFlagMembers>` where `FrozenFlagMembers = 'evaluate' | 'onChange'` (the two port methods; `FlagSet` snapshot reads are a separate returned TYPE, not port members), plus a Layer-2 return-category pin `evaluate` returns `Promise<FlagSet>` (mirroring `funnelResult`/`rawQueryResult`). Add both to the `Assertions` type + the `CAPABILITY_PRESENCE` const (`true`), importing `FeatureFlagPort`/`FlagSet` from `analytics-kit`. **Python has NO capability-presence file** (verified — no `capability_presence`/`CAPABILITY` surface under `python/examples/quillstream` or `python/src/analytics_kit`); record Python-side presence in the new flag-exercise test's assertions (the port + adapter import + a smoke exercise), or add a minimal presence assertion there — do NOT reference a non-existent Python `capability-presence` analog. Note local-eval as server-shaped-pending-E13, browser-absent-by-platform.

### Out

- **Local (in-process) eval proof** — E13 (its own example exercise + the real-stack privileged-key probe noted in the ROADMAP prerequisites).
- **A real-backend end-to-end flag delivery probe** — this story exercises the neutral surface against mock adapters; a live-key round-trip proof is a separate integration concern (no development-prerequisite key is listed for E12 remote eval — the bars are provable against a mock adapter, unlike E13/E14).
- **Session replay** — E14.
- **New library capability** — this story writes NO `src/` library code; it is consumer-side example code + tests exercising the shipped S1–S5 surface. If a bar can't be met without a library edit, that's an S1–S5 gap to route back, not an S6 change.

## Acceptance criteria

- [ ] Fernly declares a typed `flags` taxonomy slot, supplies `config.flags.bootstrap`, and its tests prove: bootstrap-seeded sync read before fetch resolves; `evaluate` + typed `getPayload`/`getFlag` narrowing; `onChange` re-fire; `useFeatureFlags` re-render.
- [ ] Fernly's flag bar-A proof swaps to a mock `FeatureFlagPort` implementation with ZERO consumer-code change and the same flag reads resolve — a NEW flag-specific assertion (the existing `bar-a-adapter-swap.test.ts` swaps the capture `AnalyticsAdapter` SPI, a different surface); the swap covers BOTH the browser adapter (via `provider.flags`) and the node flag client (via `createFlagClient`, no `provider.flags` slot on node). The bar-B proof shows config-only bootstrap + selection with no Fernly library edit.
- [ ] Quillstream exercises `evaluate({distinct_id})` (sync — no `await`) + reads + `on_change` once-fire + `distinct_id`-required validation in a NEW `test_flag_exercise.py` (following the `test_query_exercise.py` fake-`FeatureFlagPort`-Protocol pattern — Quillstream has no `bar-a`/`bar-b`-named test to extend); the mock-adapter swap and config-only-bootstrap paths pass with zero consumer change.
- [ ] Feature-flags (remote eval) recorded present in BOTH trees: Fernly's `capability-presence.ts`/`.test.ts` extended to assert the `FeatureFlagPort` export + the node `createFlagClient` factory export (WITHOUT adding `flags` to `FrozenNodeMembers`); the Python side asserts port + adapter presence in the flag-exercise test (no Python `capability-presence` file exists). Local eval noted as E13-pending / server-shaped.
- [ ] Neutrality: `grep -ri posthog` across both example trees clean; `pnpm neutrality-scan` + the Python scan analog green.
- [ ] Gates green both trees: `pnpm --filter fernly ...` (or the example's filter) build/test/typecheck/lint; `cd python && uv run pytest` for the Quillstream tests. No test hits a live backend.

## Technical notes

- **Mirror the existing example proofs — but only the ones that EXIST (corrected against the real trees):** Fernly DOES carry `bar-a-adapter-swap.test.ts`, `bar-b-config-only.test.ts`, `capability-presence.ts`/`capability-presence.test.ts`, `taxonomy.ts` — extend those exact TS patterns for flags. **Fernly's `bar-a-adapter-swap.test.ts` swaps the `AnalyticsAdapter` capture SPI** (`bar-a-adapter-swap.test.ts:18` pins the 18-member SPI + `facadeKeys` byte-identity); the FLAG bar-A is a DIFFERENT swap — a `FeatureFlagPort` implementation swap — so add a flag-specific bar-A assertion (swap the browser flag adapter reached via `provider.flags`, and separately the node flag client reached via `createFlagClient` in Fernly's `server/` surface) rather than overloading the capture-SPI swap test. **Quillstream does NOT carry `bar-a`/`bar-b`-named test analogs** (see the Quillstream Scope bullet — its proofs are `test_bar_b_import_audit.py` + per-capability `test_*_exercise.py`); add a new `test_flag_exercise.py` following the `test_query_exercise.py` fake-Protocol-adapter pattern. The point stands — flags slot into the already-proven bar-A/bar-B DISCIPLINE with no new mechanism — but the node flag bar-A proves the standalone-`createFlagClient`-satisfies-`FeatureFlagPort` swap, not a `provider.flags` slot (node has none, per S3).
- **This is the re-convergence point (— architect 2026-07-10):** everything from S1 onward was per-tree adapter work against a frozen contract; S6 re-verifies both trees against the same behavior matrix. If the trees diverge here, the divergence is a bug to fix back at the adapter (S2–S4) or the port (S1) — S6 does not paper over it.
- **No LIVE-BACKEND development prerequisite for E12 remote eval:** the bars are provable against a mock/in-memory flag adapter (the tests never hit a live backend, per CLAUDE.md). The privileged-definition-key and ingest-key prerequisites in the ROADMAP are E13 (local eval ground-truth) and E14 (replay ingest), NOT this story. **NOTE the distinction from S4's precondition:** S4 (Python adapter, on which S6 depends) carries a DE-BRAND REFERENCE precondition — `posthog-python` must be cloned at the repo root before S4 can be written. That is not a live-key prerequisite and does not change S6's mock-provable bars, but S6 cannot run until S4 has shipped (dependency graph), so the `posthog-python` clone must already be in place by the time S6 starts. No new prerequisite is introduced HERE.
- **Bar-A is the whole point:** the mock-adapter swap with zero consumer change is the hard proof that `FeatureFlagPort` is a genuine neutral seam and not a browser-adapter-shaped leak. Assert the consumer code is byte-identical across the real-adapter and mock-adapter runs.

## Shipped

<!-- Empty at draft. /implement-epics fills this once, when the story moves to stories/5-done/. Do not hand-edit. -->
