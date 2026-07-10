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
  - Config-time `super_properties` merged into every minted event (a construction-time dict, NOT runtime `register`/`unregister` verbs).
- **N-A-by-platform verbs are DOCUMENTED, not present:** no `page`, no `reset`, no runtime `register`/`unregister` on the provider — each recorded as a by-design server omission in a module docstring / the epic parity map (PY8 audits it), never silently dropped.
- Provider delegates its verbs to the `AnalyticsAdapter` SPI (PY2-S1); it constructs a `NeutralEvent` and calls `adapter.capture(event)`.

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
- [ ] `set(once=True)` is carried as a distinct intent from `set(once=False)` (the field the PY4 wire-mapper reads to choose `$set` vs `$set_once`) — but this story does NOT do the wire mapping.
- [ ] `capture` mints a `NeutralEvent` (from PY2-S1) with `super_properties` merged, and delegates to `adapter.capture(...)`.
- [ ] `uv run mypy` (strict), `uv run ruff check`, `uv run pytest` all exit 0.
- [ ] Zero vendor token in the provider surface or docstrings; `grep -ri posthog analytics_kit/provider.py analytics_kit/client.py` is clean.

## Technical notes

- **Server-shaped verb map, baselined on the TS NODE target** — architect (2026-07-09, Cluster 1). The correct baseline is `node-analytics.ts`, NOT the browser facade (`analytics-provider.ts`). `track→capture(distinct_id, ...)` (distinct_id per-call, required); `identify`/`setTraits→set(distinct_id, traits, once=False)` (server person-props update, NOT the anon→identified merge — merge is browser-only); `group→set_group_traits`; `flush`/`shutdown→sync`; `page`/`reset→N-A, documented`; `register`/`unregister→config-time super_properties dict, not runtime verbs`.
- **Frozen-15 = 13 methods + `flags?`/`replay?` None-slots.** The Python analog of TS's frozen-15: the 13 real verbs above (server-shaped) plus the two optional `Protocol`-typed capability attributes defaulting to `None`. So the feature-flags UPCOMING cycle FILLS a pre-declared slot rather than widening the seam. Do NOT implement flags/replay — declare the `None` slots only.
- **Consent = instance-level in-memory send switch — SERVER SEMANTICS ONLY.** — architect (2026-07-09, Cluster 1, high): keep `opt_in`/`opt_out`/`has_opted_out` for parity, but as an instance flag, NOT the browser's durable tri-state (`granted`/`denied`/`pending` + `resolveOptedOut`, which is browser persistence with no server home — posthog-python has only a `disabled` boolean). `opt_out` = **drop-and-discard** (a stateless server has nothing to resurrect). **CRITICAL — do NOT claim to resolve the standing OPEN browser-side denial-resurrection decision** (epic Notes + HISTORY.md L58-62): that is a *browser* persistence question about whether an explicit denial then a later grant resurrects denial-time `identify`/`register` from the memory store. The server has no such store and no such question. Scope every consent sentence to server statelessness; do NOT write anything implying the browser decision is settled.
- **`super_properties` config-time, not runtime verbs** — architect (2026-07-09, Cluster 1): browser has runtime `register`/`unregister` because super-props live in browser persistence; server follows TS node + posthog-python — super-props are a construction-time dict merged into every event. Consumer-supplied, so they cross the allowlist gate (PY3) too.
- **`set(once=)` vs the wire mapping.** `set(once=True/False)` records the caller's intent on the minted event (the `internal_kind` discriminant from PY2-S1 + the once flag). The mapping to `$set` (mutable) vs `$set_once` (first-touch) is a PY4 **wire-mapper** concern. If the exact once-carrying field shape is unclear when the builder reaches PY4, that's a PY4 architect touch, not PY2 — PY2 only needs the intent to be representable on the event.
- **Allowlist gate is a call-site here, implemented in PY3.** The TS facade gates every verb through `enforce_allowlist` pre-enrichment. PY2-S2 establishes WHERE the gate sits (the verb call-boundary) but does not implement it — PY3 ports the bespoke `enforce_allowlist` function and wires it in. Do not stub allowlist logic here.
- **CONTRACT vs IDIOM reference** (same as PY2-S1): port *to* `node-analytics.ts` + `analytics-provider.ts` (the frozen-15 shape); de-brand idiom/threading *from* posthog-python `client.py`. The facade/consent/super-props SHAPE is the TS lib's own — posthog-python does not have it.
- **Neutrality lesson from PY1 — docstrings ship** vendor-neutral; only `#`-comments carry provenance.

## Shipped

<!-- Captured by implement-epics on close. -->
