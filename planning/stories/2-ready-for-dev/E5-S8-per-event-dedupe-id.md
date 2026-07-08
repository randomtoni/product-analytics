---
id: E5-S8-per-event-dedupe-id
epic: E5-CAP-transport
status: ready-for-dev
area: capture
touches: [browser, adapters]
depends_on: []
api_impact: additive
---

# E5-S8-per-event-dedupe-id — Settle dedupeId → wire `uuid` mapping

## Why

Idempotent retries only work if client (E5) and server (E7) agree on the single dedupe field. The neutral `dedupeId` already exists on `NeutralEvent` (stamped by the facade + the browser adapter); this story locks its mapping to the wire's top-level `uuid` so retries in S3/S9 are safe to replay.

## Scope

### In

- Settle, in the browser adapter's wire-mapping seam, that the per-event neutral `dedupeId` maps to the wire's **top-level `uuid`**. The mapping is value-agnostic: it carries whatever `NeutralEvent.dedupeId` holds to the wire `uuid` field — it does NOT re-generate or re-version the id (see the version note below).
- Add the wire-mapper hook (adapter-internal) that lays out a `NeutralEvent` into its `[WIRE]` shape, placing `dedupeId` at the top-level `uuid`. This is the same mapper S2 keys off `MERGE_EVENT` in — coordinate so S2 and S8 share one wire-mapper module rather than two.
- The de-branded port **must not emit a random `$insert_id`** — no random legacy property.
- Document (in code/tests) that `dedupeId` uses the **same neutral field name** node exposes (E7's `dedupeId`), so cross-target idempotency agrees.

### Out

- The batch envelope / `data:[]` array / query params — E5-S2 + E5-S5 (`[WIRE]`).
- Node's own `dedupeId` acceptance (caller-suppliable) — E7-NODE-server-capture (this story only fixes the shared name + mapping so E7 conforms).
- Generating the id — already done: the facade stamps `dedupeId` via injectable `generateUuid` (E2-S1), the browser adapter stamps it on its own merge/traits events via `generateUuidV7`. Do not add a new generator. **Do not change either generator's UUID version** — that is out of scope for this mapping story (see the version note in Technical notes).

## Acceptance criteria

- [ ] The adapter's wire-mapper places `NeutralEvent.dedupeId` at the wire top-level `uuid` field; unit-tested against a mapped event.
- [ ] No random `$insert_id` (or any random legacy dedupe property) is emitted anywhere in the de-branded port — grep-clean + asserted by a test on the mapped wire shape.
- [ ] The neutral field name is `dedupeId` (not `insertId`, not `$insert_id`) and is documented as shared with node (E7) so client/server idempotent retries agree.
- [ ] `dedupeId` never leaks a vendor property name onto the neutral surface — it is neutral in name; the `uuid` mapping is `[WIRE]`, adapter-internal (bar A).

## Technical notes

- **`uuid`, not `$insert_id`.** Two distinct things in PostHog: the idempotency key is the **top-level `uuid`** (UUIDv7 via `getEventUuid`, `posthog-js/packages/core/src/utils/index.ts:20`; attached `posthog-core.ts:1366`, re-applied post-`before_send` `:1460`) — this is what node exposes for idempotency (`EventMessage.uuid`, E7). There is **also** a separate legacy random property `$insert_id`, added **only** by browser enrichment (`event-utils.ts:344`), which is *not* the dedup key and is absent from `core`/`node`. Map `dedupeId` → top-level `uuid`; do not confuse with `$insert_id`; do not emit a random `$insert_id`. — architect (2026-07-07): §E5.7 + §E-cross.
- **UUID-version reality (do not "fix" it in this story).** PostHog's `uuid` is v7; OUR shipped `dedupeId` value is NOT uniformly v7 today. The facade's default `generateUuid` (`packages/analytics-kit/src/uuid.ts`) and the browser-injected `cryptoRandomId` = `crypto.randomUUID()` (`packages/browser/src/create-analytics.ts:13-15`) both produce **v4** — so `track`/`page` events carry a v4 `dedupeId`. Only the browser adapter's own merge/traits events (`buildTraitsEvent`, `browser-adapter.ts:202`) stamp v7 via `generateUuidV7`. This mixed-version reality is fine for idempotency: dedupe only requires the id be **stable across a retry of the same event**, which it is (the id is stamped once, at capture, then replayed unchanged). Migrating the facade generator to v7 is a separate decision (owned by E7's cross-target settle or a later slice) — **do not change it here.** This story only pins the neutral field NAME and the `dedupeId → uuid` mapping.
- **Shared wire-mapper.** The browser adapter already emits `MERGE_EVENT = 'identify'` from `identify()` (E4-S6 note: `MERGE_EVENT` is adapter-emitted wire vocabulary, not a consumer string). The E5 wire-mapper **keys off `MERGE_EVENT`** (and the `set_traits` / `set_traits_once` / `anonymous_distinct_id` `[WIRE]` keys from `persistence-keys.ts`) to map merge/traits events to the vendor merge shape — it does not match a consumer-typed string. Build S8's `dedupeId → uuid` mapping and S2's `MERGE_EVENT`/traits mapping in **one** wire-mapper module. — architect (2026-07-07): §E5.7; E4-S6 forward note.
- Existing shape to read: `NeutralEvent` (`packages/analytics-kit/src/neutral-event.ts`) already carries `dedupeId: string` + `sessionId?`. Nothing on the neutral type changes here — the work is the adapter-internal mapping + the no-random-`$insert_id` guarantee.

## Shipped
