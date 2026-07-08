---
id: E7-NODE-server-capture
status: active
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

Six stories in `stories/2-ready-for-dev/`. Idempotency (caller `dedupeId`) is folded into S2 (the neutral options seat) + S4 (the `dedupeId → wire uuid` mapping) rather than a standalone story — it's a thin cross-cut, not a slice. **Shape (A)** — architect (2026-07-08): node is a STANDALONE client (not an `AnalyticsAdapter`, not driven by `AnalyticsProviderImpl`), reusing the seam only for taxonomy typing + the (S1-hoisted) allowlist guard; the frozen-15 `AnalyticsProvider` pin is untouched. Node re-implements its OWN wire-mapper (the seam defines no canonical wire format). Server-side bot filtering is OUT of R1 node (the bot-denylist hoist is DEFERRED — see Notes).

- **[E7-S1](../stories/2-ready-for-dev/E7-S1-hoist-allowlist-guard.md)** *(additive, no deps)* — hoist the allowlist guard out of the private `AnalyticsProviderImpl.allowed()` into an exported neutral seam function; browser delegates to it, node reuses it — one privacy contract, one code path (bar A). Behavior-preserving; existing guard tests stay green. `touches: [core, privacy]`.
- **[E7-S2](../stories/2-ready-for-dev/E7-S2-node-client-capture.md)** *(additive, depends on E7-S1)* — standalone `NodeAnalytics` client + config-selected factory + taxonomy-typed `capture(distinctId, event, props?, { dedupeId }?)` (distinctId REQUIRED, no persisted anon identity); off-list props fail loudly via the hoisted guard; mints an internal `NeutralEvent` carrying the caller `dedupeId` (or a minted fallback).
- **[E7-S3](../stories/2-ready-for-dev/E7-S3-server-batch-queue.md)** *(additive, depends on E7-S2)* — in-memory server batch queue with locked defaults (`flushAt=20`/`flushInterval=10000ms`/`maxBatchSize=100`/`maxQueueSize=1000`), size + interval flush triggers, drop-oldest on overflow. No browser transport.
- **[E7-S4](../stories/2-ready-for-dev/E7-S4-batch-delivery-wire.md)** *(additive, depends on E7-S3)* — node-internal wire-mapper (`dedupeId → top-level uuid`, NOT `$insert_id`) + gzipped `{api_key, batch, sent_at}` envelope POSTed to the config-supplied endpoint via injectable `fetch`; 413 halves the batch and retries; transient-failure retry. `touches: [adapters]`.
- **[E7-S5](../stories/2-ready-for-dev/E7-S5-server-trait-updates.md)** *(additive, depends on E7-S2)* — `setTraits(distinctId, traits, once?)` + `setGroupTraits(groupType, groupKey, traits)`, taxonomy-typed, allowlist-gated, routed through the same queue/wire; adds the trait-event / group-identify wire mapping to S4's mapper. `touches: [adapters]`.
- **[E7-S6](../stories/2-ready-for-dev/E7-S6-noop-and-lifecycle.md)** *(additive, depends on E7-S3 + E7-S4)* — whole-stack silent no-op when unkeyed (bar B); real `flush()` (force-drain) + `shutdown()` (drain within a configurable `shutdownTimeoutMs`, quiesce). `touches: [adapters]`.

Dependency graph: `E7-S1 → E7-S2 → { E7-S3 → E7-S4 → E7-S6 ; E7-S5 }`. E7-S5 depends only on E7-S2 (adds trait verbs; its wire mapping lands on top of E7-S4's mapper, so build E7-S5 after E7-S4 in practice even though the hard dep is E7-S2). E7-S6 needs both the queue (E7-S3) and delivery (E7-S4).

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
