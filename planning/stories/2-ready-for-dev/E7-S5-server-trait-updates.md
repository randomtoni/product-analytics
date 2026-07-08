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
- Both mint an internal trait/group `NeutralEvent` and route through the SAME E7-S3 queue + E7-S4 delivery. The node wire-mapper (E7-S4) gains the trait-event / group-event wire mapping: the person-trait bags map to the `[WIRE]` `set_traits` / `set_traits_once` keys and the group verb to the `[WIRE]` group-identify shape (`$group_type`/`$group_key`/`$group_set` de-branded, adapter-internal). All `$`-vocabulary stays behind the wire-mapper.

### Out

- The `distinctId`-per-call / no-persisted-identity decision (settled in E7-S2 — reused here).
- The queue/delivery/gzip/413 machinery (E7-S3/S4 — reused; this story adds only the trait-event wire mapping).
- Client-side identify/merge/alias — those are browser identity concerns (E4), NOT on the node surface. Node does no anon→identified merge (no persisted anon id to merge from).
- Consent verbs / reset — not on the node R1 surface.

## Acceptance criteria

- [ ] `setTraits(distinctId, traits, once?)` and `setGroupTraits(groupType, groupKey, traits)` exist on the node client, taxonomy-typed off the seam.
- [ ] Both gate the trait bag through the E7-S1 hoisted guard — an off-list trait key fails loudly server-side (bar A: one privacy contract).
- [ ] Both route through the E7-S3 queue and E7-S4 delivery — traits ride the same batched, gzipped, idempotent transport as capture (a caller `dedupeId` on a trait update, if the seat allows it, dedupes identically).
- [ ] The person-trait / group-trait wire mapping is adapter-internal: the `set_traits`/`set_traits_once` and group-identify `[WIRE]` keys never appear on the neutral surface; the public verbs name no vendor and no `$`-prefixed key.
- [ ] `once` correctly distinguishes mutable vs first-touch person traits at the wire level.
- [ ] All four gates green.

## Technical notes

- **Ported base** — architect (2026-07-07, epic Notes): `setTraits`/`setGroupTraits` map to posthog-js node's person/group property updates. Reference — posthog-source-guide (2026-07-08): `identify()` (`client.ts:685-702`) emits `$identify` with `properties = { $set, $set_once, $anon_distinct_id }` (node has no `$anon_distinct_id` server-side — omit it; there's no persisted anon id). `setPersonProperties` (`client.ts:764-770`) emits `$set`. `groupIdentify()` (`client.ts:2014-2030`) emits `$groupidentify` with `distinctId` defaulting to `` `$${groupType}_${groupKey}` `` and properties `{ $group_type, $group_key, $group_set: properties }`. ALL `$`-vocabulary is de-branded and adapter-internal — it lives in the E7-S4 node wire-mapper, never on the public surface.
- The `set_traits` / `set_traits_once` wire keys already have de-branded precedent in the browser wire-mapper (`packages/browser/src/wire-mapper.ts` — `SET_TRAITS_KEY`/`SET_TRAITS_ONCE_KEY`); node re-implements the same de-branded target names in its OWN wire-mapper (node does not import browser's). Keep the neutral↔wire naming consistent across targets where it's a genuine shared concept, but the mapper code stays node-local (E7-S4 decision).
- Node's `setTraits` is a distinct verb, NOT the browser facade's `setTraits(traits, once?)` (which routes through `identify` on a persisted distinct id). Node takes `distinctId` explicitly — server-truth, no persisted identity. Do NOT try to share the browser facade path.
- **Frozen-15 pin:** these are node-client verbs on the narrower node surface, NOT additions to `AnalyticsProvider`. Pin untouched.
- api_impact additive.

## Shipped
