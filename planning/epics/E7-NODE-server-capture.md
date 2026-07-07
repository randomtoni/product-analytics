---
id: E7-NODE-server-capture
status: planned
area: node
touches: [adapters]
api_impact: additive
blocked_by: [E3-CORE-taxonomy-allowlist]
updated: 2026-07-07
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

_Tentative slice — story files not yet written._

- **Neutral server surface + node adapter skeleton** — `capture(id, event, props)` mapped to the neutral event object inside the adapter (over the ported stateless base); wired to the seam's taxonomy typing + allowlist guard so off-list keys fail loudly server-side. Depends on E3.
- **Server queue + defaults** — `flushAt=20` / `flushInterval=10000ms` / `maxBatchSize=100` / `maxQueueSize=1000`, oldest-drop on overflow.
- **Batch delivery** — gzipped batch envelope POSTed to the config-supplied endpoint; 413 → halve-batch-and-retry.
- **Server-side trait updates** — `setTraits` / `setGroupTraits` for person/group property updates.
- **Idempotency** — caller-suppliable neutral `dedupeId` as the dedupe key, mapped adapter-internally to the wire top-level `uuid` (not `$insert_id`); shares the `dedupeId` field name with the browser (E5).
- **No-op + lifecycle** — whole-stack no-op when unkeyed; `flush()` / `shutdown()` with a configurable timeout.

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

## Expansion path

The node adapter satisfies the same neutral SPI as the browser adapter (E2), so a future self-hosted or non-vendor server backend is **one new adapter, zero consumer change** — it maps the neutral capture/trait verbs to its own wire. Server-side flag evaluation (`node` area) drops in later behind the already-declared `FeatureFlagPort` extension point, additively.
