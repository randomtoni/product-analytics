---
id: E7-NODE-server-capture
status: done
area: node
touches: [adapters]
api_impact: additive
blocked_by: [E3-CORE-taxonomy-allowlist]
updated: 2026-07-08
---

# E7-NODE-server-capture — Node server-side capture

## Why

Completes the capture surface with server-truth events: `@analytics-kit/node` captures events keyed on the **same distinct id** as the browser, so server-side and client-side events stitch into the same funnels. It needs only the core seam (E2/E3), not the browser epics, so it runs in its own lane and can be built in parallel. Informed by `research/ARCHITECT-RELEASE1.md` §E7.

## Success criteria

- `@analytics-kit/node` exposes `capture(id, event, props)`, `setTraits(...)`, `setGroupTraits(...)`, `flush()`, and `shutdown()` — the neutral server surface from BRIEF §6, keyed on the same distinct id as the browser client.
- Server capture routes through the **same** seam taxonomy typing and allowlist guard as the browser (they live in the seam package, E3): `capture`/`setTraits`/`setGroupTraits` are typed off `defineTaxonomy<T>()`, and an off-list prop/trait key **fails loudly on the server too** — nothing off-list leaves from the server (bar A: one privacy contract, identical for every adapter).
- The queue batches on `flushAt=20` / `flushInterval=10000ms`, caps at `maxBatchSize=100` / `maxQueueSize=1000`, and **drops oldest on overflow**; each batch POSTs a **gzipped** envelope to a **config-supplied endpoint**; a **413 halves the batch and retries**.
- A **caller-suppliable neutral `dedupeId`** is the idempotency key, mapped **adapter-internally** to the wire top-level `uuid` (**NOT `$insert_id`**); a retried `capture` carrying the same `dedupeId` is idempotent; the neutral field name is the **same `dedupeId` the browser uses** (E5-S8 settles it in the seam) so cross-target idempotency holds.
- Unkeyed ⇒ a **whole-stack silent no-op** (queue never sends), same posture as E2's config-selected factory.
- `flush()` force-sends the buffer; `shutdown()` drains the queue within a **configurable timeout** and resolves.
- Zero vendor references on the neutral surface: no vendor endpoint/hostname (config-supplied), no `$`-prefixed or `ph_` naming; the wire mapping (batch path, `{api_key, batch, sent_at}` envelope, gzip content-type) is **adapter-internal**. Provider-swap = one adapter, zero consumer change holds for the server target.

## Stories

All six shipped to `stories/5-done/`. Idempotency (caller `dedupeId`) is folded into S2 (the neutral options seat) + S4 (the `dedupeId → wire uuid` mapping). **Shape (A)**: node is a STANDALONE `NodeAnalytics` client (not an `AnalyticsAdapter`, not driven by `AnalyticsProviderImpl`), reusing the seam only for taxonomy typing + the (S1-hoisted) `enforceAllowlist` guard; the frozen-15 `AnalyticsProvider` pin held. Node re-implements its OWN wire-mapper + gzip (`node:zlib`) + queue (the seam defines no canonical wire format). Server-side bot filtering was OUT of R1 (the bot-denylist hoist stays DEFERRED — no server UA signal — see Notes).

- **[E7-S1](../stories/5-done/E7-S1-hoist-allowlist-guard.md)** *(done — `3f3fb2f`)* — hoisted the private `allowed()` into exported `enforceAllowlist` (variadic, both policy branches verbatim, keys-only) + exported `PropsParam`; browser delegates, node reuses — **bar A is literally one privacy code path**. `touches: [core, privacy]`.
- **[E7-S2](../stories/5-done/E7-S2-node-client-capture.md)** *(done — `2c7e429`)* — standalone `NodeAnalytics` client + config-selected factory + settled two-overload taxonomy-typed `capture(distinctId, event, props?, { dedupeId }?)` (distinctId REQUIRED); off-list fails loudly via the shared guard; mints a `NeutralEvent` with `node:crypto` `dedupeId` fallback. Own `keyof` pin.
- **[E7-S3](../stories/5-done/E7-S3-server-batch-queue.md)** *(done — `05ed33b`)* — node's own `BatchQueue<T>` (locked defaults 20/10000/100/1000, size+interval earlier-of triggers, `maxBatchSize` slicing, drop-oldest, injected `send`). No browser transport.
- **[E7-S4](../stories/5-done/E7-S4-batch-delivery-wire.md)** *(done — `efcd87b`)* — node wire-mapper (`dedupeId → top-level uuid`, NO `$insert_id`) + gzip (`node:zlib`) `{api_key, batch, sent_at}` envelope POSTed to the config endpoint via injectable `fetch`; per-delivery 413-halving + fixed-delay transient retry (resolves on give-up). `touches: [adapters]`.
- **[E7-S5](../stories/5-done/E7-S5-server-trait-updates.md)** *(done — `b57177a`)* — `setTraits(distinctId, traits, once?)` + `setGroupTraits(...)`, taxonomy-typed + gated, node's `$set`/`$groupidentify` NESTED-in-`properties` wire shape (not browser's top-level lift), keyed off reserved event names. `touches: [adapters]`.
- **[E7-S6](../stories/5-done/E7-S6-noop-and-lifecycle.md)** *(done — `b1e0524`)* — `NodeNoop` null-object (unkeyed whole-stack no-op, bar B); real `flush()` force-drain + `shutdown()` loop-drain within configurable `shutdownTimeoutMs` (resolve-on-timeout) + quiesce (no post-shutdown re-arm). `touches: [adapters]`.

Built topo order: `E7-S1 → E7-S2 → E7-S3 → E7-S4 → E7-S5 → E7-S6`. Deferred cross-adapter follow-up (from S5 review): replace name-based reserved-event recognition (`MERGE_EVENT`/`AUTOCAPTURE_EVENT`/`set_traits`/`set_group_traits`) with a structural `NeutralEvent` discriminant — a SEAM change retiring the untyped-hatch collision across browser + node at once.

## Out of scope

- Browser transport/persistence (E5/E6) — server capture shares no queue/persistence with the browser; it only shares the distinct id and the neutral seam.
- Persisting the server queue — server processes are ephemeral; in-memory queue + drain-on-shutdown is correct. Durability is the consumer's infra concern.
- Server-side flag evaluation (`node` area, but out of Release 1 — feature-flags is a typed extension point only).
- The query client (E8, `query` area) — a separate server surface with its own auth (personal key) and endpoint.

## Notes

- **Independence / lane.** Needs only the core cycle (E2/E3), NOT the browser epics. Runs in its own `{node}` lane per ROADMAP; `blocked_by: [E3-CORE-taxonomy-allowlist]` — E3 must land because the same allowlist/taxonomy seam gates server capture. — architect (2026-07-07): the node adapter satisfies the same neutral SPI as browser (E2); its batching/wire is adapter-internal, so it shares nothing with the browser lane but the distinct id and the seam.
- **Ported base.** De-brand posthog-js `packages/node` (server client) + `packages/core` stateless base; public capture is object-based internally (`EventMessage`), and the BRIEF's `capture(id, event, props)` is a thin neutral signature over it. `setTraits`/`setGroupTraits` map to the ported person/group property updates. — architect (2026-07-07): keep `capture(id, event, props)` as the neutral signature; map it to the object envelope **inside** the adapter — don't re-plumb node's internals with positional args.
- **Queue defaults locked.** `flushAt=20`, `flushInterval=10000ms`, `maxBatchSize=100`, `maxQueueSize=1000`; **413 → halve `maxBatchSize` and retry**; **oldest-dropped** at `maxQueueSize`. — architect (2026-07-07), from core-stateless.
- **Idempotency key.** Neutral `dedupeId` maps to the wire top-level `uuid`, **NOT `$insert_id`** (`$insert_id` is a separate legacy random prop, not the dedup key). The neutral field name must be the **same as the browser (E5)** and settled in the seam so cross-target idempotency holds. — architect (2026-07-07).
- **Whole-stack no-op.** Unkeyed ⇒ the same whole-stack `NoopAdapter` posture as E2; the queue never sends. Server storage seam is in-memory only (no cookie/localStorage persistence server-side), which is correct for node. — architect (2026-07-07).
- **De-brand.** No vendor endpoints/hostnames — the consumer supplies the endpoint (mirrors E5's `ingestHost`, no region/vendor-host defaulting). No `$`-prefixed or `ph_` naming on the neutral surface; the batch path, `{api_key, batch, sent_at}` envelope, and gzip `Content-Type` are `[WIRE]`, adapter-internal. The transport seam is a pluggable `fetch` so the consumer can inject a fetch impl / first-party proxy. — architect (2026-07-07).
- **Signature parity.** Keep the neutral server capture signature aligned with browser `track`/`identify` so a distinct id captured client-side and server-side stitches (BRIEF §6: "keyed on the same distinct id").
- **Client shape = standalone, not the facade/SPI.** — architect (2026-07-08): node ships its OWN thin `NodeAnalytics` client with the BRIEF §6 surface; it does NOT implement `AnalyticsAdapter` and is NOT driven by `AnalyticsProviderImpl` (its surface is narrower/different — no track/page/reset/consent, and `distinctId` is per-call, not persisted). It reuses the seam ONLY for the taxonomy type utilities (`defineTaxonomy`/`ShapeOf`/`PropsParam`, already cleanly importable) and the allowlist guard — which requires a small seam HOIST (E7-S1) of the guard out of the private `AnalyticsProviderImpl.allowed()` into an exported neutral function, so browser + node share one privacy code path. Mirrors posthog-js `PostHogBackendClient` (its own class over a stateless core). The frozen-15 `AnalyticsProvider` pin is untouched.
- **Own wire-mapper (nothing hoisted).** — architect (2026-07-08): node RE-IMPLEMENTS its own `NeutralEvent → [WIRE]` mapper (E7-S4). The seam deliberately defines no canonical wire format (REFERENCE-BACKEND.md:34-41); the browser mapper is browser-saturated (pageview/pageleave/geoip/`{data:[]}`+offset) with almost no overlap with node's `{api_key, batch, sent_at}` envelope. The ONLY shared neutral contract is the `dedupeId` field name (→ `uuid`) — a one-line mapping, not a shared module. Node is the "second backend adapter maps its own shape from the same NeutralEvent" the reference-backend anticipates.
- **Server-side bot filtering OUT of R1 (denylist hoist DEFERRED).** — PM, grounded posthog-source-guide (2026-07-08): PostHog's node SDK does essentially NO bot filtering — no `navigator` server-side, and its one opt-in path only RENAMES a manually-UA-tagged pageview, never drops. BRIEF §6's node contract lists capture/traits/no-op/idempotent — no bot filtering. So the E5-S7/E6-S3 carry-forward (hoisting the pure `DEFAULT_BLOCKED_UA_STRS` / `isBlockedUA` denylist to the seam WHEN node needs server-side UA filtering) does NOT trigger in E7 — there is no server-side UA signal to filter on in R1. The denylist stays browser-local (`packages/browser/src/bot-detection.ts`); the hoist is deferred until a real server-side UA-filtering need lands (a future story where the consumer surfaces a request-header UA). Note only — no work in E7.

## Expansion path

The node adapter satisfies the same neutral SPI as the browser adapter (E2), so a future self-hosted or non-vendor server backend is **one new adapter, zero consumer change** — it maps the neutral capture/trait verbs to its own wire. Server-side flag evaluation (`node` area) drops in later behind the already-declared `FeatureFlagPort` extension point, additively.
