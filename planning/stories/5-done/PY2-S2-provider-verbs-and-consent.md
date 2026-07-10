---
id: PY2-S2-provider-verbs-and-consent
epic: PY2-CORE-python-seam
status: ready-for-dev
area: core
touches: [adapters]
depends_on: [PY2-S1-adapter-spi-and-neutral-event]
api_impact: additive
---

# PY2-S2-provider-verbs-and-consent — Server-shaped provider contract, verb surface & consent switch

## Why

The provider is the consumer-facing seam — the server-shaped verb surface baselined on the TS *node* target (NOT the browser facade), plus the `flags?`/`replay?` capability slots and the instance-level consent switch. Settling it here means PY4 (capture) and PY5 (query) build against a fixed verb surface. This is the Python realization of TS `E2-S3` (facade) + `E2-S5` (consent gating) + `E2-S6`'s provider-side slots, server-shaped.

## Scope

### In

- `analytics_kit/provider.py` (the provider contract + impl; the empty S2-skeleton `client.py` re-exports it or hosts the public entry — see the module map in the epic):
  - The server-shaped verb surface, baselined on `ts/packages/node/src/node-analytics.ts`:
    - `capture(distinct_id, event, properties=None, *, dedupe_id=None) -> None` — `distinct_id` **required first-positional**; mints a `NeutralEvent`.
    - `set(distinct_id, traits, once=False) -> None` — the server person-props update (the `identify`/`setTraits` analog), NOT the anonymous→identified merge.
    - `set_group_traits(group_type, group_key, traits) -> None` — the `group` analog.
    - `flush() -> None` / `shutdown() -> None` — sync analogs (real delivery/drain is PY4; here they delegate to the adapter/scaffolding).
    - `opt_in() -> None` / `opt_out() -> None` / `has_opted_out() -> bool` — the consent trio as an **instance-level in-memory send switch** (see Technical notes).
  - The `flags: FeatureFlagPort | None = None` and `replay: SessionReplayPort | None = None` capability slots (the Python analog of TS `undefined`-in-R1; `None` this release, filled by the feature-flags cycle).
  - Config-time `super_properties` merged into every `capture`d event's `properties` (a construction-time dict, NOT runtime `register`/`unregister` verbs). NOT merged into `set`/`set_group_traits` internal events — those carry only their nested trait wrapper (see Technical notes).
- **N-A-by-platform verbs are DOCUMENTED, not present:** no `page`, no `reset`, no runtime `register`/`unregister` on the provider — each recorded as a by-design server omission in a module docstring / the epic parity map (PY8 audits it), never silently dropped.
- **The frozen-15 accounting table SHIPS as a durable artifact** (not just prose): a module-level docstring in `provider.py` carrying the full 15-member mapping below, so PY8's parity matrix audits a concrete table, not an inference. Every one of the TS `AnalyticsProvider`'s 15 members (13 methods + `flags?`/`replay?`) MUST appear with its server disposition:

  | TS member (`analytics-provider.ts`) | Server disposition |
  |---|---|
  | `track` | → `capture(distinct_id, event, properties=None, *, dedupe_id=None)` (direct analog) |
  | `identify` | → `set(distinct_id, traits, once=False)` (idiomatic: server person-props update, NOT anon→identified merge) |
  | `setTraits` | → `set(...)` (same verb as `identify`; two TS members collapse to one server verb) |
  | `group` | → `set_group_traits(group_type, group_key, traits)` (idiomatic) |
  | `optIn` | → `opt_in()` (idiomatic: instance send-switch, not durable tri-state) |
  | `optOut` | → `opt_out()` (idiomatic: drop-and-discard) |
  | `hasOptedOut` | → `has_opted_out()` (direct analog) |
  | `flush` | → `flush()` (direct analog, sync) |
  | `shutdown` | → `shutdown()` (direct analog, sync) |
  | `page` | **N-A by platform** (no server pageview surface) — documented, not implemented |
  | `reset` | **N-A by platform** (no persisted server identity to re-anonymize) — documented, not implemented |
  | `register` | **N-A as a runtime verb** → config-time `super_properties` dict instead |
  | `unregister` | **N-A as a runtime verb** (no runtime super-prop store server-side) — documented, not implemented |
  | `flags?` (member 14) | declared `Protocol`-typed optional slot, `= None` this cycle (filled by the flags cycle) |
  | `replay?` (member 15) | declared `Protocol`-typed optional slot, `= None` this cycle (filled by the flags cycle) |

  That is all 15 accounted for: 9 mapped verbs (with `identify`+`setTraits` collapsing to one), 4 N-A-documented, 2 declared `None`-slots.
- **Provider mints EVERY event and routes through the single capture verb (architect ruling 2026-07-09, Option A — see PY2-S1).** The `AnalyticsAdapter` SPI is capture-only + lifecycle; there is NO `adapter.set`/`adapter.group`. So each verb mints a `NeutralEvent` (PY2-S1) and calls `adapter.capture(event)`:
  - `capture(...)` → mints a plain event (no `internal_kind`), `super_properties` merged into `properties`.
  - `set(distinct_id, traits, once=False)` → mints an event with `internal_kind="set_traits"` and `properties = {"set_once": traits}` when `once=True` else `{"set": traits}` (the neutral once-carrier — see Technical notes); calls `adapter.capture(event)`.
  - `set_group_traits(group_type, group_key, traits)` → mints an event with `internal_kind="set_group_traits"`, `distinct_id = f"{group_type}_{group_key}"` (the provider-owned composite, mirroring `node-analytics.ts:171`), and `properties = {"group_type": group_type, "group_key": group_key, "group_set": traits}` — the NEUTRAL group wrapper (neutral tokens `group_type`/`group_key`/`group_set`, mirroring `node-analytics.ts:163-167` one level up from the wire; PY4 renames to the de-branded wire keys). `group_type`/`group_key` are routing identifiers, NOT consumer properties, so they are not allowlist-gated (only `traits` is — PY3); calls `adapter.capture(event)`.
  - `flush`/`shutdown` → delegate to `adapter.flush()`/`adapter.shutdown()`.

### Out

- The config + `create_analytics` factory + `NoopAdapter` — **PY2-S3** (this story's provider is constructed by that factory).
- The sync-client + background-thread delivery scaffolding — **PY2-S4** (here `flush`/`shutdown` delegate to the adapter; the queue/thread is PY4).
- The allowlist gate on the verbs — the gate is PY3's bespoke function; PY2-S2 leaves the gate call-site as the seam PY3 wires in (do NOT implement allowlist logic here).
- The taxonomy typing of the verbs — PY3.
- Any `$set`/`$set_once` wire mapping — PY4.
- Resolving the browser-side explicit-denial-resurrection decision — **out of scope and MUST NOT be claimed** (see Technical notes).

## Acceptance criteria

- [ ] The provider exposes `capture` (distinct_id required first-positional), `set`, `set_group_traits`, `flush`, `shutdown`, `opt_in`, `opt_out`, `has_opted_out` — the server-shaped surface.
- [ ] The provider carries `flags` / `replay` attributes defaulting to `None`; no flag/replay behavior exists.
- [ ] The provider has **no** `page`, `reset`, `register`, or `unregister` verb; each is documented as a by-design server omission (docstring / parity note).
- [ ] `opt_out()` flips an instance-level in-memory switch that suppresses subsequent sends; `has_opted_out()` reads it; `opt_in()` clears it. Under opt-out, `capture`/`set`/`set_group_traits` do not deliver (drop-and-discard).
- [ ] `set(once=True)` mints `properties={"set_once": traits}` and `set(once=False)` mints `properties={"set": traits}` (both with `internal_kind="set_traits"`) — the neutral once-carrier PY4's wire-mapper renames; the neutral keys are `set`/`set_once`, never `$`-prefixed. This story does NOT do the wire mapping.
- [ ] Every verb (`capture`/`set`/`set_group_traits`) mints a `NeutralEvent` (from PY2-S1) — `capture` with `super_properties` merged into `properties`, `set`/`set_group_traits` with the appropriate `internal_kind` — and routes through the single `adapter.capture(event)` (there is no `adapter.set`/`adapter.group` — Option A).
- [ ] `uv run mypy` (strict), `uv run ruff check`, `uv run pytest` all exit 0.
- [ ] Zero vendor token in the provider surface or docstrings; `grep -ri posthog analytics_kit/provider.py analytics_kit/client.py` is clean.

## Technical notes

- **Server-shaped verb map, baselined on the TS NODE target** — architect (2026-07-09, Cluster 1). The correct baseline is `node-analytics.ts`, NOT the browser facade (`analytics-provider.ts`). `track→capture(distinct_id, ...)` (distinct_id per-call, required); `identify`/`setTraits→set(distinct_id, traits, once=False)` (server person-props update, NOT the anon→identified merge — merge is browser-only); `group→set_group_traits`; `flush`/`shutdown→sync`; `page`/`reset→N-A, documented`; `register`/`unregister→config-time super_properties dict, not runtime verbs`.
- **Frozen-15 = 13 methods + `flags?`/`replay?` None-slots.** The Python analog of TS's frozen-15: the 13 real verbs above (server-shaped) plus the two optional `Protocol`-typed capability attributes defaulting to `None`. So the feature-flags UPCOMING cycle FILLS a pre-declared slot rather than widening the seam. Do NOT implement flags/replay — declare the `None` slots only.
- **Consent = instance-level in-memory send switch — SERVER SEMANTICS ONLY.** — architect (2026-07-09, Cluster 1, high): keep `opt_in`/`opt_out`/`has_opted_out` for parity, but as an instance flag, NOT the browser's durable tri-state (`granted`/`denied`/`pending` + `resolveOptedOut`, which is browser persistence with no server home — posthog-python has only a `disabled` boolean). `opt_out` = **drop-and-discard** (a stateless server has nothing to resurrect). **Mechanism (don't over-build):** a single `self._opted_out: bool` on the provider — `opt_out()` sets it, `opt_in()` clears it, `has_opted_out()` reads it, and each verb short-circuits with `if self._opted_out: return` BEFORE minting/capturing. Do NOT port the TS provider's consent-driven adapter-swap (`resyncActiveAdapter`, `noopAdapter` delegate) — that defense-in-depth exists because the browser adapter must still write persistence under opt-out; the stateless server has no persistence to protect, so the plain guard IS the complete semantic (mirrors posthog-python's single `disabled` boolean). **CRITICAL — do NOT claim to resolve the standing OPEN browser-side denial-resurrection decision** (epic Notes + HISTORY.md L58-62): that is a *browser* persistence question about whether an explicit denial then a later grant resurrects denial-time `identify`/`register` from the memory store. The server has no such store and no such question. Scope every consent sentence to server statelessness; do NOT write anything implying the browser decision is settled.
- **`super_properties` config-time, not runtime verbs** — architect (2026-07-09, Cluster 1): browser has runtime `register`/`unregister` because super-props live in browser persistence; server follows TS node + posthog-python — super-props are a construction-time dict merged into every event. Consumer-supplied, so they cross the allowlist gate (PY3) too.
- **`super_properties` merge into `capture` ONLY, NOT `set`/`set_group_traits`.** The TS node target merges nothing extra into the `set`/`group` internal events — their `properties` is exactly the nested `{set|set_once: traits}` / `{group_type, group_key, group_set: traits}` wrapper (`node-analytics.ts:148-167`). Super-props are event-property enrichment on captured events, not person/group traits. So the provider merges `super_properties` into `capture`'s `properties`, but the `set`/`set_group_traits` minted events carry ONLY their nested trait wrapper — do not fold super-props into the trait bag (it would misattribute event context as person/group properties).
- **`set(once=)` neutral once-carrier — PINNED HERE (architect ruling 2026-07-09, Option A; this story is the named source of truth PY4 renames from).** The minted `set_traits` event carries TWO things: `internal_kind="set_traits"` (the event-CLASS discriminant, PY2-S1) AND the once intent expressed by **nesting the trait bag under a NEUTRAL property key in `properties`**: `once=False` ⇒ `properties = {"set": traits}`; `once=True` ⇒ `properties = {"set_once": traits}`. The neutral tokens are literally `set` / `set_once` — NOT `$`-prefixed, NOT the TS `WIRE_*` values (those stay adapter-internal to PY4). This mirrors the TS node target's nesting (`node-analytics.ts:148-151`) shifted one level up from the de-branded wire keys to neutral ones, keeping PY2 wire-free. PY4's wire-mapper renames the neutral `set`/`set_once` keys → the de-branded wire keys. Rejected: widening `internal_kind` to a `set_traits_once` variant (conflates event-class with merge-semantics), or a bespoke top-level `NeutralEvent` field (drifts out of sync with the bag it describes, and churns the S1 type). Do NOT do the wire mapping here.
- **Allowlist gate is a call-site here, implemented in PY3.** The TS facade gates every verb through `enforce_allowlist` pre-enrichment. PY2-S2 establishes WHERE the gate sits (the verb call-boundary) but does not implement it — PY3 ports the bespoke `enforce_allowlist` function and wires it in. Do not stub allowlist logic here.
- **CONTRACT vs IDIOM reference** (same as PY2-S1): port *to* `node-analytics.ts` + `analytics-provider.ts` (the frozen-15 shape); de-brand idiom/threading *from* posthog-python `client.py`. The facade/consent/super-props SHAPE is the TS lib's own — posthog-python does not have it.
- **Neutrality lesson from PY1 — docstrings ship** vendor-neutral; only `#`-comments carry provenance.

## Shipped

> Captured by `implement-epics` on 2026-07-09.

- **Files added:** `python/src/analytics_kit/provider.py`, `python/tests/test_provider.py` (26 cases)
- **Files changed:** `python/src/analytics_kit/client.py` (re-exports `Analytics`), `__init__.py` (re-export)
- **New public API:** `Analytics(adapter, super_properties=None)` — `capture`/`set`/`set_group_traits`/`flush`/`shutdown`/`opt_in`/`opt_out`/`has_opted_out`, `flags`/`replay` `None`-slots; module docstring carries the durable frozen-15 accounting table. Wire-key constants at module top (`SET_KEY`/`SET_ONCE_KEY`/`GROUP_TYPE_KEY`/`GROUP_KEY_KEY`/`GROUP_SET_KEY` + event-name `SET_TRAITS_EVENT`/`SET_GROUP_TRAITS_EVENT`) — PY4's rename source.
- **Tests added:** 26 provider cases via a recording capture-only adapter (verb minting, once-carrier, group wrapper, consent drop-and-discard, super-props-on-capture-only, minted event-name)
- **Commit:** `core-cycle` (message = story title)
- **Reviewer notes:** consent-drop + super-props isolation adversarially probed **clean** (both negative-controlled). Two suggestions **addressed inline before ship** (not deferred): the minted `event` NAME on set/group was `"set"`/`"group_set"` (reused wrapper-key constants) → fixed to `"set_traits"`/`"set_group_traits"` (PY4 carries the event name to the wire unchanged, so the mint site had to be right); added the missing `event.event` assertions that were the blind spot.
- **Cross-story seams exposed:** **S3** factory builds `Analytics(adapter, super_properties=config.super_properties)`; unkeyed → inject `NoopAdapter` (whole-stack no-op, no provider change). **PY3** allowlist gate wires in at each verb call-boundary, AFTER the `if self._opted_out: return` guard, BEFORE minting; gate `properties`/`traits` only (routing `group_type`/`group_key` NOT gated). **PY4** renames the neutral wrapper keys → wire keys, keys off `internal_kind` (never event name); the minted event NAMES (`set_traits`/`set_group_traits`) already match the wire and pass through unchanged.
