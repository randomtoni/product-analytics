---
id: E7-S2-node-client-capture
epic: E7-NODE-server-capture
status: ready-for-dev
area: node
touches: []
depends_on: [E7-S1-hoist-allowlist-guard]
api_impact: additive
---

# E7-S2-node-client-capture — Node client skeleton + neutral server capture

## Why

The first server-side target: a standalone `@analytics-kit/node` client with the BRIEF §6 server surface, minting server-truth events keyed on a caller-supplied distinct id. This is the skeleton every later node story hangs off — the client class, the taxonomy-typed `capture(id, event, props, { dedupeId })`, and the server-side allowlist gate. It routes a captured event into an internal `NeutralEvent`, gated by the SAME privacy contract as the browser.

## Scope

### In

- Build out `packages/node/src/` (replace the `index.ts` stub) with a standalone `NodeAnalytics` client class (name by role, never a vendor) exposing the BRIEF §6 surface skeleton: `capture(id, event, props?, options?)`, plus stubs/placeholders for `flush()` / `shutdown()` (real bodies land in E7-S6) so the surface type-checks. `setTraits` / `setGroupTraits` land in E7-S5.
- `capture(distinctId, event, props?, { dedupeId }?)`: `distinctId` REQUIRED per call (no persisted anonymous identity server-side); `event` the neutral name; `props` the neutral properties; a 4th options bag carrying an optional caller-suppliable `dedupeId`.
- Taxonomy typing reused from the seam: type the public `capture` (and later trait verbs) off the seam's `defineTaxonomy<T>()` / `ShapeOf` / `PropsParam` type utilities (imported from `analytics-kit`), mirroring how the seam types `track`. A config-supplied `taxonomy` gives the consumer full type-safety; the library ships zero event names.
- Server-side allowlist enforcement: run the E7-S1 hoisted guard on `props` (and later traits) BEFORE the event is minted — an off-list key fails loudly server-side (throw / drop-and-error-log per config `onViolation`), identical to the browser.
- Map the neutral call into an internal `NeutralEvent` (the seam type): stamp `distinctId`, `event`, `properties`, `timestamp` (`new Date()` at capture), and `dedupeId` — using the caller-supplied `dedupeId` when present, else minting one (mirror the browser facade's `generateUuid()` fallback) so `NeutralEvent.dedupeId: string` is always populated and an un-keyed server event still dedupes on retry. Hand the `NeutralEvent` to the (E7-S3) enqueue seam — in this story, a minimal in-memory hand-off / buffer stub is fine; real batching is E7-S3.
- A `NodeAnalyticsConfig` shape: `key?`, `taxonomy?`, `allowlist?`, `onViolation?`, `ingestHost?`, `ingestPath?`, and a `fetch?` injection point (the transport primitive) — plus the batching knobs consumed by E7-S3 (`flushAt?` / `flushInterval?` / `maxBatchSize?` / `maxQueueSize?`). A config-selected factory (`createAnalytics(config)` in `packages/node/src/create-analytics.ts`, mirroring browser) resolves the client.

### Out

- The real batch queue / defaults / overflow (E7-S3).
- Batch delivery, gzip, wire envelope, node wire-mapper, 413-halving (E7-S4).
- `setTraits` / `setGroupTraits` (E7-S5).
- No-op-without-key wiring + real `flush()`/`shutdown()` bodies (E7-S6). A skeleton that compiles is enough here.
- Any browser concern: no persistence (cookie/localStorage), no session id, no beacon/unload, no enrichment, no autocapture. Node ignores `NeutralEvent`'s browser-only fields (`isPageView`/`sessionId`/`enrichmentProfile`).
- Feature-flag evaluation, alias, reset, consent verbs — not on the node R1 surface.

## Acceptance criteria

- [ ] `@analytics-kit/node` exports a `NodeAnalytics` client (via a `createAnalytics` factory) with `capture(distinctId, event, props?, { dedupeId }?)` where `distinctId` is a required first arg.
- [ ] `capture` is taxonomy-typed off the seam's `defineTaxonomy<T>()` — a consumer-declared event + props type-check; `props` for an event with no declared props is optional (mirrors `PropsParam`).
- [ ] An off-list `props` key fails loudly server-side through the E7-S1 hoisted guard (throw or drop-and-error-log per `onViolation`) — SAME privacy contract as the browser (bar A). Nothing off-list is minted into the `NeutralEvent`.
- [ ] A capture with no caller `dedupeId` still produces a `NeutralEvent` with a populated `dedupeId`; a capture WITH a caller `dedupeId` carries that exact value onto the `NeutralEvent.dedupeId` (idempotency substrate for E7-S4).
- [ ] The public surface names no vendor and no wire vocabulary: no `uuid`, no `$`-prefixed / `ph_` keys, no vendor endpoint/hostname (endpoint is config-supplied). Provider-swap holds for the server target (bar A).
- [ ] Zero browser coupling: node imports nothing from `@analytics-kit/browser`; no cookie/localStorage/session/beacon.
- [ ] All four gates green.

## Technical notes

- Shape (A) — architect (2026-07-08): node is a STANDALONE client, NOT an `AnalyticsAdapter` and NOT driven by `AnalyticsProviderImpl` (its surface is narrower/different from the frozen-15 `AnalyticsProvider` — track/page/reset/consent are absent server-side; `distinctId` is per-call, not persisted). Node reuses the seam ONLY for the taxonomy type utilities (already cleanly importable: `defineTaxonomy`/`ShapeOf`/`PropsParam`/`TaxonomyShape` from `analytics-kit`) and the E7-S1 hoisted allowlist guard. Do NOT make node's `capture` conform to the provider's `track` signature — node ships its own typed-signature layer. This mirrors posthog-js `PostHogBackendClient` (`posthog-js/packages/node/src/client.ts:125`), its own class over a stateless core.
- **Frozen-15 pin held:** node adds NO verbs to `AnalyticsProvider`. Its surface is a separate, narrower client interface — the pin is untouched.
- **`dedupeId` seat** — architect (2026-07-08): the caller-suppliable `dedupeId` sits in a 4th OPTIONS bag (`capture(id, event, props, { dedupeId })`), not a 4th positional primitive — it's optional and the bag is the extensible seat (a future per-call `timestamp` override for backfill is the obvious next tenant). It stays NEUTRAL: `dedupeId` is the already-agreed neutral field name (`NeutralEvent.dedupeId`, and REFERENCE-BACKEND.md lists it among the two neutral commitments). The `dedupeId → wire uuid` mapping is a WIRE concern that lives entirely in the node wire-mapper (E7-S4), never on this signature. Same neutral name as the browser; different provenance (browser mints, server caller supplies).
- **`distinctId` required, no throwaway path** — posthog-source-guide (2026-07-08): PostHog's node types mark `distinctId` optional only to support an async-context fallback that mints a throwaway uuid + `$process_person_profile=false`. R1 does NOT port that — BRIEF §6 says server capture is "keyed on the same distinct id"; the server always knows who it acts for. Make `distinctId` a required first arg. No persisted anonymous device id server-side.
- **Ported base** — de-brand posthog-js `packages/node/src/client.ts` (public `capture`) + `packages/core/src/posthog-core-stateless.ts` (the stateless enqueue base). Keep the neutral `capture(id, event, props)` signature; map it to the internal `NeutralEvent` INSIDE the client — don't re-plumb node internals with positional args. `$set`/`$set_once`/`$groups`/`$`-anything are PostHog wire vocabulary — they stay behind the E7-S4 wire-mapper, never on this surface.
- **Config-selected factory** mirrors the browser (`packages/browser/src/create-analytics.ts`): `createAnalytics(config)` resolves the client; overloads give taxonomy-typed vs default returns. The unkeyed⇒no-op resolution lands in E7-S6 (skeleton here can construct the real client).
- api_impact additive: a brand-new package surface.

## Shipped
