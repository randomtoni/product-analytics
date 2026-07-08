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
- **Ordering vs S5 (both extend `AnalyticsProvider`):** S6 adds `flags?`/`replay?` to the same `AnalyticsProvider` type S5 augments with the consent trio. Under `/implement-epics` topo order S6 runs after S5 (by number) and extends the type S5 leaves; no hard dependency (both depend only on S3), but coordinate the two additions if open concurrently.
- **Bar-A expansion (epic Expansion path):** the optional ports light up when an adapter implements them — additive, zero facade or consumer change. This story exists to make that future purely additive.

## Shipped
