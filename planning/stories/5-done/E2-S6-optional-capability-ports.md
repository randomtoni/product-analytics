---
id: E2-S6-optional-capability-ports
epic: E2-CORE-provider-seam
status: ready-for-dev
area: core
touches: []
depends_on: [E2-S3-analytics-provider-facade]
api_impact: additive
---

# E2-S6-optional-capability-ports — Declared-but-unimplemented `FeatureFlagPort` / `SessionReplayPort` slots

## Why

Feature flags and session replay are out of release 1, but the seam must reserve their shape as typed extension points so a future adapter lights them up additively — with zero facade or consumer change. Declaring them now (as `undefined`-in-release-1 slots) keeps them out of `track`/`identify` forever.

## Scope

### In

- `FeatureFlagPort` and `SessionReplayPort` port interfaces in the seam (`packages/analytics-kit/src/`) — **minimal sketches**, not frozen contracts (see Technical notes).
- Hang them off the `AnalyticsProvider` type (S3) as **optional** capability slots: `flags?: FeatureFlagPort` · `replay?: SessionReplayPort`. Populated by an adapter only if provided; `undefined` in release 1.
- Export the two port types from the seam's public surface.

### Out

- **Any** flag-evaluation or session-recording logic — zero behavior ships (BRIEF "explicitly OUT this release"). These are types only.
- Folding flags/replay into `track`/`identify`/`capture` — they stay **separate** ports, never bundled.
- Freezing the port method signatures — sketch only; the real shape is settled when an adapter first implements one.

## Acceptance criteria

- [ ] `FeatureFlagPort` and `SessionReplayPort` are declared and exported from the seam.
- [ ] `AnalyticsProvider` carries `flags?` and `replay?` as **optional** properties typed to those ports; both are `undefined` in release 1.
- [ ] No flag/replay runtime logic exists anywhere in the seam — a grep for flag/replay behavior finds only type declarations.
- [ ] The ports are not referenced from `track`/`identify`/`capture` — they are independent slots.
- [ ] `pnpm --filter analytics-kit typecheck`, `lint`, `test`, `build` all exit 0.
- [ ] `grep -ri posthog packages/analytics-kit/src` is clean.

## Technical notes

- **Declared-but-unimplemented optional ports (— architect 2026-07-07):** define the port types in the seam and hang them off the provider as optional slots (`analytics.flags?`, `analytics.replay?`), populated by an adapter only if provided (`undefined` in release 1). Keep them **separate** ports, never folded into `track`/`identify` — PostHog bundles flags into its one class (`posthog-js/packages/browser` + `packages/core`); we deliberately don't, so flags/replay can arrive as their own adapters later without touching the capture path.
- **Sketch, don't freeze (epic confidence note, 2026-07-07):** exact extension-point signatures are med-confidence — write the smallest plausible port shape (enough to prove the slot exists and typechecks) and leave the method surface loose. Freezing waits until a real flag/replay adapter needs it; over-specifying now is a premature-abstraction risk.
- **E2 slots are type-only + always `undefined` — do NOT wire them from the adapter (cross-story pin):** S6 `depends_on: [E2-S3]` only — it does **not** touch S2's `AnalyticsAdapter` SPI, and that SPI intentionally has **no** `flags?`/`replay?` slot in E2. So a builder must **not** attempt `this.flags = adapter.flags` on the facade — that won't typecheck (the adapter has no such member) and would drag S2 into S6's scope. In E2, declare the optional `flags?`/`replay?` properties on the `AnalyticsProvider` interface and simply leave the internal facade class **not declaring them** (optional interface members need no class implementation), so `analytics.flags`/`analytics.replay` are `undefined` at runtime. Adapter-population is the **future additive path** — when a real flag/replay adapter arrives it extends the SPI and the facade surfaces it then, zero change to the capture path. That future step is out of scope here.
- **Ordering vs S5 (both extend `AnalyticsProvider`):** S6 adds `flags?`/`replay?` to the same `AnalyticsProvider` type S5 augments with the consent trio. Under `/implement-epics` topo order S6 runs after S5 (by number) and extends the type S5 leaves; no hard dependency (both depend only on S3), but coordinate the two additions if open concurrently.
- **Bar-A expansion (epic Expansion path):** the optional ports light up when an adapter implements them — additive, zero facade or consumer change. This story exists to make that future purely additive.
- > Reviewer note (2026-07-07, epic-level, for E5/E7): Bar B's injection point exists (`createAnalytics(config, adapter?)`) but config→adapter SELECTION isn't exercised yet — `createAnalytics` uses the passed adapter or falls back to `NoopAdapter`; it does not yet pick an adapter from `config`. That's target-package territory (browser/node factories read `config.key` to build+inject their adapter). Add a real config-driven-selection test when the first concrete target ships.
- > Reviewer note (2026-07-07, for E3): the `track`/`group`/`page` method-signature type-pin in `analytics-provider.test.ts` will need updating when E3 changes those signatures (E3's own churn, not a regression); the 13-member `keyof` enumeration stays valid (same names). Insert the allowlist guard on the capture verbs only — ports sit off to the side and don't interact.

## Shipped

> Captured by `implement-epics` on 2026-07-07.

- **Files added:** `packages/analytics-kit/src/ports.ts` (`FeatureFlagPort` = `{ getFlag(key): unknown }`, `SessionReplayPort` = `{ start(): void }` — minimal sketches)
- **Files changed:** `src/analytics-provider.ts` (+`flags?`/`replay?` optional interface members; impl class untouched → undefined at runtime), `src/index.ts` (export the ports), `src/analytics-provider.test.ts` (type-pin 11→13 + port tests). `src/adapter.ts` (S2 SPI) UNTOUCHED.
- **New public API:** `FeatureFlagPort`, `SessionReplayPort`; `AnalyticsProvider.flags?`/`replay?` (optional, `undefined` in release 1)
- **Tests added:** optionality/typing type-pins, export-identity, `flags`/`replay` undefined at runtime, capture-path-independence. 55 total in package.
- **Commit:** `E2-S6-optional-capability-ports — Declared-but-unimplemented FeatureFlagPort / SessionReplayPort slots` on `core-cycle`
- **Reviewer notes:** 0 critical, 1 suggestion (keep the intent comment — no change) + 2 epic-level forward notes → see Technical notes
- **Cross-story seams exposed:** ports are type-only + separate from capture (never folded into track/identify) — a future flag/replay adapter lights them up additively (bar-A expansion). Adapter-population is the future path (extends S2's SPI + surfaces on the facade then).
