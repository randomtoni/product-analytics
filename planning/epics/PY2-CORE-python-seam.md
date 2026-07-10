---
id: PY2-CORE-python-seam
status: active
area: core
touches: [adapters]
api_impact: additive
blocked_by: [PY1-NODE-python-scaffold]
updated: 2026-07-09
---

# PY2-CORE-python-seam — The vendor-neutral Python seam

## Why

The seam is the contract every Python capability hangs off — the adapter SPI, the provider contract, the config-selected factory, and the no-op. It is the Python realization of what the TS `E2-CORE-provider-seam` settled, ported *to* the shipped TS seam (`ts/packages/analytics-kit/src/{adapter,analytics-provider}.ts`) as the contract reference, de-branded from `posthog-python`. Settling it here means PY4/PY5/PY6 build against a fixed shape. Informed by the architect consult (2026-07-09), Clusters 1 + 2.

## Success criteria

- The adapter SPI and the query-client contract are `typing.Protocol`s (structural), not ABCs — a consumer backend satisfies the seam **without importing/subclassing a library base** (bar A: one adapter, zero coupling).
- The provider surface is **server-shaped**, baselined on the TS *node* target (`node-analytics.ts`), NOT the browser facade: `distinct_id` is a required per-call argument, there is no persisted identity, no `page`, no `reset`, no runtime `register`/`unregister`. The capability catalog (the frozen-15) is *accounted for* — each verb ruled direct-analog / idiomatic-adaptation / N-A-by-platform (see Notes) — with N-A verbs documented, not silently dropped. **The frozen-15 is 13 methods + the two OPTIONAL capability ports `flags?`/`replay?` (members 14 + 15): the Python seam carries `flags`/`replay` as declared-but-unimplemented `Protocol`-typed optional slots defaulting to `None` (the Python analog of the TS `undefined`-in-R1 posture, `ports.ts`) so the feature-flags UPCOMING cycle FILLS a pre-declared slot rather than widening the seam.** `context()` rides the widened root return, not the frozen-15 itself (TS pin).
- Config parse validates with **Pydantic** (the one genuine inbound boundary); `NeutralEvent`, the wire envelope, and internal data are plain `@dataclass` / `TypedDict` — no per-event Pydantic on the capture hot path.
- The client posture is **sync with a background flush thread** (posthog-python's model), plus a `sync_mode`-equivalent inline flag; **no asyncio client** in this cycle.
- Unkeyed ⇒ a **whole-stack silent no-op** null object (the `NoopAdapter` posture), config-selected by the factory — same as TS.
- Consent verbs (`opt_in`/`opt_out`/`has_opted_out`) exist for parity but gate an **instance-level in-memory send switch**, NOT the browser's durable tri-state (`pending` is meaningless without a per-user durable store the server doesn't own).
- Zero vendor references on the neutral surface: no `$`-prefixed names, no vendor endpoint/host, no `posthog`/`ph_` naming; wire vocabulary is adapter-internal.

## Stories

Linear chain — `S1 → S2 → S3 → S4` (each depends on the prior); topo-sortable via `depends_on`. Written to `stories/2-ready-for-dev/`. They fill the empty PY1 submodule skeleton and add the seam modules.

- **[PY2-S1](../stories/2-ready-for-dev/PY2-S1-adapter-spi-and-neutral-event.md)** *(additive, no deps)* — `NeutralEvent` plain `@dataclass` (+ `NeutralProperties`/`NeutralTraits`, server-scoped `internal_kind` `Literal`; no browser-only fields) + the `AnalyticsAdapter` `Protocol` SPI (server verbs + neutral primitives) + `FeatureFlagPort`/`SessionReplayPort` sketch ports.
- **[PY2-S2](../stories/2-ready-for-dev/PY2-S2-provider-verbs-and-consent.md)** *(additive, depends on S1)* — the server-shaped provider (verbs baselined on the TS node target: `capture`/`set`/`set_group_traits`/`flush`/`shutdown` + the consent trio as an instance switch; `page`/`reset`/`register`/`unregister` N-A documented) + `flags`/`replay` `None`-slots + config-time `super_properties`.
- **[PY2-S3](../stories/2-ready-for-dev/PY2-S3-config-factory-and-noop.md)** *(additive, depends on S1+S2)* — Pydantic `AnalyticsConfig` (the one inbound boundary) + `create_analytics` factory (unkeyed ⇒ whole-stack no-op) + the `NoopAdapter` null object.
- **[PY2-S4](../stories/2-ready-for-dev/PY2-S4-sync-client-thread-scaffolding.md)** *(additive, depends on S3)* — the sync-client lifecycle seam (`flush`/`shutdown` sync, NO asyncio) + the `sync_mode` flag + the delivery-sink plug-point PY4's queue/thread attaches to; no real threading here.

Build topo order: `PY2-S1 → PY2-S2 → PY2-S3 → PY2-S4`.

**Module map** (fills the PY1 skeleton; PY3/PY4/PY5 build on it):

- `analytics_kit/neutral_event.py` — `NeutralEvent` + `NeutralProperties`/`NeutralTraits` + `InternalKind` (S1)
- `analytics_kit/adapter.py` — `AnalyticsAdapter` `Protocol` SPI + `ConsentState` (S1)
- `analytics_kit/ports.py` — `FeatureFlagPort`/`SessionReplayPort` sketch `Protocol`s (S1)
- `analytics_kit/provider.py` — the server-shaped provider contract + impl + consent switch (S2); `client.py` (PY1 skeleton) re-exports it as the public entry
- `analytics_kit/config.py` — Pydantic `AnalyticsConfig` (S3, extended with `sync_mode` in S4)
- `analytics_kit/noop.py` — the `NoopAdapter` null object (S3)
- `analytics_kit/factory.py` — `create_analytics` (S3)
- `analytics_kit/__init__.py` — public exports (S1→S4 each add theirs)

## Out of scope

- Actual server capture delivery / batching / wire mapping (PY4) — this epic settles the SPI + factory shape, not the transport.
- Taxonomy + allowlist (PY3) — declared as seam boundaries here, implemented in PY3.
- The query client implementation (PY5) — only its `Protocol` is co-located with the seam if convenient; the HTTP adapter is PY5.
- Browser-only verbs (`page`, `reset`, cross-subdomain persistence, super-property `register`/`unregister`) — N-A-by-platform, documented, never implemented.

## Notes

- **posthog-python is the de-branding/idiom reference, NOT the contract reference.** — architect (2026-07-09): the frozen-15 facade, the consent tri-state, the taxonomy generic, and the payload allowlist **do not exist in posthog-python** — they are the TS library's OWN surface. The **TS seam is the contract**; posthog-python informs transport, threading, and de-branding only.
- **Protocol, not ABC.** — architect (2026-07-09, Cluster 2, high): structural typing matches the TS `interface`-based seam and lets an adapter satisfy the SPI without importing a library base (the coupling the neutral seam exists to avoid). Mark `@runtime_checkable` only where the factory needs `isinstance`. Rejected: `abc.ABC` + `@abstractmethod` — nominal inheritance tightens coupling.
- **Server-shaped verb mapping (the frozen-15 accounted for).** — architect (2026-07-09, Cluster 1): `track`→`capture(distinct_id, event, properties=None, *, dedupe_id=None)` (distinct_id REQUIRED first-positional, TS-node shape); `identify`/`setTraits`→`set(distinct_id, traits, once=False)` (server identify is a person-props update, NOT the anon→identified merge — merge is browser-only); `group`→`set_group_traits`; `flush`/`shutdown`→direct sync analogs; `page`/`reset`→**N-A-by-platform, documented**; `register`/`unregister`→**config-time `super_properties` dict, not runtime verbs**; `context()`→a request-scoped context manager (see PY6), NOT the browser enrichment profile. The 13 methods above + `flags?` + `replay?` = the frozen-15 accounting.
- **`flags?`/`replay?` declared as `None` slots now — a refiner catch.** — architect (2026-07-09 refiner re-validation, high): the TS frozen count is *15*, not 13, precisely because `flags?: FeatureFlagPort` / `replay?: SessionReplayPort` are declared-but-`undefined` optional members (`analytics-provider.ts` + `ports.ts`). If PY2 mapped only the 13 methods the Python seam would be a frozen-*13*, and the feature-flags UPCOMING cycle would have to WIDEN the seam instead of filling a pre-declared slot — the exact seam churn the frozen count exists to prevent. Carry `flags`/`replay` as optional `Protocol`-typed attributes defaulting to `None` (Python's `undefined` analog); no implementation this cycle — the port shapes are `ports.ts`'s loose sketches, still not frozen contracts. Rejected: defer the slot declaration to the flags cycle — reintroduces seam churn and drops PY2 below documented parity for zero cost saved (two optional attrs).
- **Pydantic only at genuine boundaries.** — architect (2026-07-09, Cluster 2, high): Pydantic at config parse (inbound) + query-result decode (PY5, inbound wire); plain `@dataclass`/`TypedDict` for `NeutralEvent`/wire/specs (library-built, trusted-by-construction per the E3 rule). Allowlist enforcement is a bespoke function, NOT Pydantic schema validation. Rejected: Pydantic everywhere — per-event `BaseModel` on the hot path is throughput cost for zero safety gain on data the library just built.
- **Sync client + background thread; no asyncio.** — architect (2026-07-09, Cluster 2, high): posthog-python is sync-with-daemon-thread (`consumer.py`), with `sync_mode` for inline. The TS node single-thread model is a JS-runtime artifact, not a contract. Most Python server code is sync; a thread-backed sync client serves Django/WSGI/scripts/Celery and works fine called from an ASGI request (send offloaded to the thread, not awaited). An async client is a clean **additive future**, not this cycle. Rejected: async-first or dual sync+async — doubles surface + test matrix for no R-parity gain.
- **Consent weakened server-side.** — architect (2026-07-09, Cluster 1, high): keep `opt_in`/`opt_out`/`has_opted_out` as parity verbs but as an instance-level send switch; the durable tri-state (`granted`/`denied`/`pending` + `resolveOptedOut`) is browser persistence and has no server home. posthog-python has only a `disabled` boolean. Per-end-user consent is the consuming app's per-request responsibility server-side. **PM-locked (2026-07-09):** `opt_out` = **drop-and-discard** — a stateless server holds nothing to resurrect, so an in-memory send gate that drops-and-discards is the complete server semantic (posthog-python's single `disabled` boolean confirms the whole server surface is a send gate). Resolves the architect's surviving open question #3.
  - **Scope of this lock: SERVER semantics ONLY (refiner-scoped, architect-confirmed 2026-07-09, high).** This lock does **NOT** resolve, contradict, or pre-empt the STANDING OPEN USER DECISION on the browser/TS side (HISTORY.md: denial-time `identify`/`register`/`group` persistence-verb writes resurrecting to durable storage on later opt-in). That browser question only exists because the browser HAS persistence to resurrect; the server's statelessness DISSOLVES the question rather than answering it. The two are independent — a future browser-side ruling is unaffected by this server lock, and no reader should infer the browser decision was settled here.

## Expansion path

A second backend (self-hosted / non-vendor) is one new module satisfying the same `Protocol` SPI — zero consumer change (bar A). An async client is additive alongside the sync one behind the same seam. The already-declared feature-flag / session-replay extension points (TS `ports.ts`) get their Python `Protocol` analogs when those cycles land.
