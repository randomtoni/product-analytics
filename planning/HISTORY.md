# History — analytics-kit

Cycle narrative, newest-first. The [ROADMAP](ROADMAP.md) holds the forward plan; this file holds
what closed cycles established and why.

## `core` cycle — closed 2026-07-08 (E1, E2, E3)

The vendor-neutral seam reached v1. The cycle stood up the workspace and settled the two
load-bearing shapes every downstream area now builds on.

- **Seam shape settled (E2).** Two objects, one boundary: the consumer-facing `AnalyticsProvider`
  facade (owns taxonomy typing, allowlist guard, consent gating, neutral-event construction) holds
  an `AnalyticsAdapter` SPI (the minimal neutral contract a backend satisfies — `fetch` transport,
  persisted-property get/set, client identity, plus neutral capture/identify/group/alias +
  flush/shutdown over neutral event objects). No `$`-names and no `/batch/` envelope leak onto the
  SPI; batching/transport/persistence stay adapter-internal. "Unkeyed ⇒ silent" is a whole-stack
  `NoopAdapter` null-object, not a `disabled` flag. The per-event dedupe/insert-id field was fixed
  to the neutral `dedupeId` name (maps to the wire top-level `uuid`) so browser and node idempotency
  cannot diverge. `FeatureFlagPort` / `SessionReplayPort` are declared-but-unimplemented optional
  capability slots — `undefined` in release 1.

- **Library-own privacy + typing surface settled (E3).** `defineTaxonomy()` returns a runtime
  object that both brands the compile-time type and powers the runtime key registry — one
  declaration drives typing and the allowlist. The payload allowlist runs synchronously at the
  facade call-boundary, **pre-enrichment** (the inverse position of PostHog's post-enrichment
  `before_send`), throws on an off-list consumer key by default, and holds identically for every
  adapter. Rule fixed here: keys the library **computes** are trusted; keys/values the consumer
  **supplies** are gated. Neither the taxonomy generic nor the allowlist exists in `posthog-js` —
  this is entirely the library's own surface.

- **Both acceptance bars proven at the seam.** Bar A (provider-swap = one adapter, zero consumer
  change) holds via the SPI; bar B (new-app = config only) holds via the preserved untyped
  `createAnalytics({}).track('x')` path.

- **Reference-backend decision recorded (T1).** Out-of-cycle but settled alongside: the release-1
  reference backend defaults to **T1 = Neon Postgres only**, storage-agnostic and graduation-additive,
  with everything below the adapter seam (storage, query computation) kept backend-internal. See
  [`REFERENCE-BACKEND.md`](REFERENCE-BACKEND.md).

Epics archived to [`epics/done/`](epics/done/): E1-CORE-workspace-scaffold,
E2-CORE-provider-seam, E3-CORE-taxonomy-allowlist.
