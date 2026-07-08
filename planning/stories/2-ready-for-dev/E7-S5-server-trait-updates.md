---
id: E7-S5-server-trait-updates
epic: E7-NODE-server-capture
status: ready-for-dev
area: node
touches: [adapters]
depends_on: [E7-S2-node-client-capture]
api_impact: additive
---

# E7-S5-server-trait-updates — Server-side person & group trait updates

## Why

Completes the node capture surface with the two property-update verbs from BRIEF §6: `setTraits` (person properties) and `setGroupTraits` (group properties). A server often knows authoritative person/group state (plan tier, org size) it must push independently of an event — these route through the SAME queue, wire, and allowlist as capture.

## Scope

### In

- `setTraits(distinctId, traits, once?)`: set person properties server-side. `once` distinguishes mutable (overwrite) from first-touch (set-once). Keyed on the caller-supplied `distinctId` (required, per node's no-persisted-identity posture).
- `setGroupTraits(groupType, groupKey, traits)`: set group/cohort properties server-side.
- Both taxonomy-typed off the seam (`traits` typed off the taxonomy's `traits`; `groupType` off `groups`), mirroring E7-S2's typing approach.
- Both run the E7-S1 hoisted allowlist guard on the trait bag BEFORE minting — an off-list trait key fails loudly server-side (bar A).
- Both mint an internal trait/group `NeutralEvent` (a reserved internal event NAME, NOT a consumer event — mirror the browser's `MERGE_EVENT = 'identify'` constant pattern: node defines its own reserved internal names, e.g. a set-traits name and a group-identify name) and route through the SAME E7-S3 queue + E7-S4 delivery. The node wire-mapper (E7-S4) gains the trait-event / group-event wire mapping. **Wire shape = the de-branded posthog-NODE convention (NOT the browser's `set_traits` top-level lift):** person traits map to the de-branded `$set`-style event with the trait bags NESTED inside `properties` (`properties.[set] = traits`, `properties.[set_once] = onceTraits` — de-branded from posthog node's `event:'$set'` + `properties.$set`/`$set_once`, `client.ts:764-770`); the group verb maps to the de-branded group-identify shape (`properties.[group_type]`/`[group_key]`/`[group_set]`, de-branded from `$group_type`/`$group_key`/`$group_set`, `client.ts:2014-2030`), with `distinctId` defaulting to a `` `${groupType}_${groupKey}` `` composite when the caller supplies none. All `$`-vocabulary and the de-branded wire keys stay behind the E7-S4 wire-mapper.

### Out

- The `distinctId`-per-call / no-persisted-identity decision (settled in E7-S2 — reused here).
- The queue/delivery/gzip/413 machinery (E7-S3/S4 — reused; this story adds only the trait-event wire mapping).
- Client-side identify/merge/alias — those are browser identity concerns (E4), NOT on the node surface. Node does no anon→identified merge (no persisted anon id to merge from).
- Consent verbs / reset — not on the node R1 surface.

## Acceptance criteria

- [ ] `setTraits(distinctId, traits, once?)` and `setGroupTraits(groupType, groupKey, traits)` exist on the node client, taxonomy-typed off the seam.
- [ ] Both gate the trait bag through the E7-S1 hoisted guard — an off-list trait key fails loudly server-side (bar A: one privacy contract).
- [ ] Both route through the E7-S3 queue and E7-S4 delivery — traits ride the same batched, gzipped, idempotent transport as capture (a caller `dedupeId` on a trait update, if the seat allows it, dedupes identically).
- [ ] The person-trait / group-trait wire mapping is adapter-internal: the de-branded `$set`-style nested trait keys and the group-identify `[WIRE]` keys never appear on the neutral surface; the public verbs name no vendor and no `$`-prefixed key.
- [ ] `once` correctly distinguishes mutable vs first-touch person traits at the wire level (`once === true` routes the bag to the set-once key, else the set key — de-branded from posthog node's `$set` vs `$set_once`).
- [ ] All four gates green.

## Technical notes

- **Ported base** — architect (2026-07-07, epic Notes): `setTraits`/`setGroupTraits` map to posthog-js node's person/group property updates. Reference — posthog-source-guide (2026-07-08): `identify()` (`client.ts:685-702`) emits `$identify` with `properties = { $set, $set_once, $anon_distinct_id }` (node has no `$anon_distinct_id` server-side — omit it; there's no persisted anon id). `setPersonProperties` (`client.ts:764-770`) emits `$set`. `groupIdentify()` (`client.ts:2014-2030`) emits `$groupidentify` with `distinctId` defaulting to `` `$${groupType}_${groupKey}` `` and properties `{ $group_type, $group_key, $group_set: properties }`. ALL `$`-vocabulary is de-branded and adapter-internal — it lives in the E7-S4 node wire-mapper, never on the public surface.
- **Wire-shape caution — node's `$set` differs from browser's `set_traits`.** The browser's `SET_TRAITS_KEY`/`SET_TRAITS_ONCE_KEY` (`packages/browser/src/persistence-keys.ts:58-59`) are TOP-LEVEL wire keys the browser mapper LIFTS out of a `MERGE_EVENT = 'identify'` event's properties (`wire-mapper.ts:106-125`) — a browser-merge convention. posthog's NODE SDK uses a different shape: a standalone `event:'$set'` with the trait bags NESTED inside `properties.$set`/`$set_once` (`client.ts:764-770`), because node does no anon→identified merge. Node ports the NODE shape (nested `$set`), NOT the browser's top-level lift. Node picks its own de-branded key names for these nested keys in its OWN wire-mapper (node does not import browser's mapper or its `persistence-keys` constants). Cross-target naming consistency is nice-to-have but NOT load-bearing here — the two are genuinely different wire events.
- **Composition with S2/S4 — verified.** S5 hard-depends on S2 (reuses the client class, the taxonomy typing, the hoisted allowlist guard, and the `crypto.randomUUID` dedupe-id mint) and lands its wire mapping ON TOP of S4's node wire-mapper — so build S5 AFTER S4 in practice (epic dep graph already sequences this). If a caller `dedupeId` seat is offered on the trait verbs, it flows to `uuid` identically to capture (S4). The trait/group `NeutralEvent`s ride the SAME queue (S3) + delivery (S4) as capture — no separate transport.
- Node's `setTraits` is a distinct verb, NOT the browser facade's `setTraits(traits, once?)` (which routes through `identify` on a persisted distinct id). Node takes `distinctId` explicitly — server-truth, no persisted identity. Do NOT try to share the browser facade path.
- **Frozen-15 pin:** these are node-client verbs on the narrower node surface, NOT additions to `AnalyticsProvider`. Pin untouched.
- api_impact additive.

## Shipped
