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
  - Declare a `flags` slot in Quillstream's taxonomy; supply `config.flags.bootstrap`.
  - Exercise `evaluate(context={distinct_id})` + `get_payload`/`get_flag`/`get_all` reads + `on_change` once-fire.
  - Prove `distinct_id`-required validation (the server asymmetry) surfaces cleanly.
  - **Bar-A proof:** swap to a mock flag adapter, zero consumer change (mirror the existing Quillstream bar-A test).
  - **Bar-B proof:** config-only bootstrap + adapter selection, no library edit.
- **Capability-presence / parity check** — record feature-flags as present in BOTH trees (remote eval) in whatever capability-presence surface the examples already carry (`capability-presence.ts` in Fernly + the Python analog); note local-eval as server-shaped-pending-E13, browser-absent-by-platform.

### Out

- **Local (in-process) eval proof** — E13 (its own example exercise + the real-stack privileged-key probe noted in the ROADMAP prerequisites).
- **A real-backend end-to-end flag delivery probe** — this story exercises the neutral surface against mock adapters; a live-key round-trip proof is a separate integration concern (no development-prerequisite key is listed for E12 remote eval — the bars are provable against a mock adapter, unlike E13/E14).
- **Session replay** — E14.
- **New library capability** — this story writes NO `src/` library code; it is consumer-side example code + tests exercising the shipped S1–S5 surface. If a bar can't be met without a library edit, that's an S1–S5 gap to route back, not an S6 change.

## Acceptance criteria

- [ ] Fernly declares a typed `flags` taxonomy slot, supplies `config.flags.bootstrap`, and its tests prove: bootstrap-seeded sync read before fetch resolves; `evaluate` + typed `getPayload`/`getFlag` narrowing; `onChange` re-fire; `useFeatureFlags` re-render.
- [ ] Fernly's bar-A test swaps to a mock flag adapter with ZERO consumer-code change and the same flag reads resolve; the bar-B test proves config-only bootstrap + selection with no Fernly library edit.
- [ ] Quillstream exercises `evaluate({distinct_id})` + reads + `on_change` once-fire + `distinct_id`-required validation; its bar-A (mock-adapter swap) and bar-B (config-only) tests pass with zero consumer change.
- [ ] The capability-presence surface records feature-flags (remote eval) present in BOTH trees; local eval noted as E13-pending / server-shaped.
- [ ] Neutrality: `grep -ri posthog` across both example trees clean; `pnpm neutrality-scan` + the Python scan analog green.
- [ ] Gates green both trees: `pnpm --filter fernly ...` (or the example's filter) build/test/typecheck/lint; `cd python && uv run pytest` for the Quillstream tests. No test hits a live backend.

## Technical notes

- **Mirror the existing example proofs verbatim** — Fernly already carries `bar-a-adapter-swap.test.ts`, `bar-b-config-only.test.ts`, `capability-presence.ts`, `taxonomy.ts`; extend those exact patterns for flags rather than inventing a new harness. Quillstream (`python/examples/quillstream/`) carries the Python analogs (PY7). The point is that flags slot into the ALREADY-PROVEN bar-A/bar-B harness with no new mechanism.
- **This is the re-convergence point (— architect 2026-07-10):** everything from S1 onward was per-tree adapter work against a frozen contract; S6 re-verifies both trees against the same behavior matrix. If the trees diverge here, the divergence is a bug to fix back at the adapter (S2–S4) or the port (S1) — S6 does not paper over it.
- **No development prerequisite for E12 remote eval:** the bars are provable against a mock/in-memory flag adapter (the tests never hit a live backend, per CLAUDE.md). The privileged-definition-key and ingest-key prerequisites in the ROADMAP are E13 (local eval ground-truth) and E14 (replay ingest), NOT this story.
- **Bar-A is the whole point:** the mock-adapter swap with zero consumer change is the hard proof that `FeatureFlagPort` is a genuine neutral seam and not a browser-adapter-shaped leak. Assert the consumer code is byte-identical across the real-adapter and mock-adapter runs.

## Shipped

<!-- Empty at draft. /implement-epics fills this once, when the story moves to stories/5-done/. Do not hand-edit. -->
