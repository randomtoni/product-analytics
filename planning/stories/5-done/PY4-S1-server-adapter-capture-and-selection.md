---
id: PY4-S1-server-adapter-capture-and-selection
epic: PY4-NODE-server-capture
status: ready-for-dev
area: node
touches: [adapters]
depends_on: []
api_impact: additive
---

# PY4-S1-server-adapter-capture-and-selection — Server adapter capture entry + factory `config.key` selection

## Why

PY2 (seam) + PY3 (taxonomy/allowlist) already built the entire PROVIDER surface: `Analytics.capture`/`set`/`set_group_traits` mint fully-formed `NeutralEvent`s (`dedupe_id` via `uuid4()`, the neutral wrapper keys `set`/`set_once`/`group_type`/`group_key`/`group_set`, `set_traits`/`set_group_traits` event names, `internal_kind` discriminant), allowlist-gate them, taxonomy-type them, and call `adapter.capture(event)`. **PY4 does NOT re-create any of that.** This story builds the real server `AnalyticsAdapter` the provider talks to — its capture entry (enqueue) + lifecycle/consent/library-id impl — and the factory's `config.key` → build+inject the server adapter (unkeyed ⇒ the existing `NoopAdapter`). It is the Python realization of TS `E7-S2` (node client capture), but **adapter-driven, not a standalone client** (the key architectural difference from TS — see Technical notes).

## Scope

### In

- A new server-adapter module (see the module map in the epic — e.g. `analytics_kit/server/adapter.py` or `analytics_kit/node_adapter.py`) implementing the SHIPPED `AnalyticsAdapter` Protocol (`python/src/analytics_kit/adapter.py`): `capture(event)`, `flush()`, `shutdown()`, `send(...)`, `get_consent_state()`/`set_consent_state()`, `get_library_id()`/`get_library_version()`.
  - `capture(event: NeutralEvent) -> None` — the adapter's data entry: **enqueue** the already-minted event onto the batch queue (PY4-S2). This story wires the enqueue seam to a queue stub/injected sink; the real queue + thread is PY4-S2, the real delivery is PY4-S3.
  - `get_library_id()` returns the neutral `"analytics-kit"`; `get_library_version()` returns the version — neutral placeholders, never a vendor token.
  - Consent getters/setters back the adapter's own consent field (the provider's instance switch already suppresses upstream; the adapter's consent state is the SPI-level backing).
- Factory `config.key` selection — the second half of the two-piece shape PY2-S3 established: a target-module entry (or an extension to `create_analytics`'s adapter resolution wired via the target module) that reads `config.key` and, when present, **builds the server adapter and injects it**; when absent, falls back to the seam's `NoopAdapter` (already the factory default). The seam factory itself stays generic and imports no target adapter — the `config.key`→server-adapter wiring lives in the target module (mirrors TS `E7-S6` factory selection, but selecting an ADAPTER for the existing provider, not a separate client).
- Config extended additively for the ingest endpoint the adapter needs — the **host + path fields** (`ingest_host`, `ingest_path`; the snake_case analog of TS `config.ts`'s `ingestHost`/`ingestPath`, NOT a single combined `endpoint`); queue/flush knobs land in PY4-S2, retry/shutdown knobs in PY4-S4, as each needs them. `extra="forbid"`, so they are known fields the factory reads. NO vendor host/region default — an absent `ingest_host` is a misconfiguration the consumer must fix (TS `send-batch.ts:54-58`).

### Out

- The provider verbs / event minting / allowlist gating / taxonomy typing / `dedupe_id` fallback — **ALREADY BUILT in PY2+PY3**; do NOT duplicate. The adapter receives a fully-formed `NeutralEvent`.
- The batch queue + background daemon thread + drop-oldest + `sync_mode` paths — **PY4-S2**.
- The wire-mapper + gzip envelope + transport POST + `dedupe_id`→`uuid` — **PY4-S3**.
- Retry classification / fetch-failure normalization / 413-halving / drain-timeout — **PY4-S4**.
- A separate null-object client — NOT needed: unkeyed ⇒ the existing seam `NoopAdapter` (the Python no-op is adapter-level, already shipped; see Technical notes — this is where Python diverges from TS E7-S6's `NodeNoop`).

## Acceptance criteria

- [ ] A server `AnalyticsAdapter` implementation exists satisfying the SHIPPED Protocol structurally (all members: `capture`/`flush`/`shutdown`/`send`/consent getters+setter/library-id+version).
- [ ] `adapter.capture(event)` enqueues the already-minted `NeutralEvent` (no re-minting, no re-gating — the provider did that); the enqueue routes to the queue seam PY4-S2 fills.
- [ ] `create_analytics(config)` with `config.key` present builds+injects the server adapter (a keyed provider talks to the real adapter); with `config.key` absent, the provider is the whole-stack `NoopAdapter` (unkeyed ⇒ silent — bar B).
- [ ] The seam factory imports no target adapter (inward-only preserved); the `config.key`→adapter wiring lives in the target module.
- [ ] `config.py` gains `ingest_host: str | None = None` and `ingest_path: str | None = None` (both `extra="forbid"` known fields); no collision with the existing `key`/`super_properties`/`sync_mode`/`allowlist`/`on_violation`/`taxonomy` fields.
- [ ] `get_library_id()` / `get_library_version()` return neutral values (no vendor token); consent getters/setter back the adapter's consent field.
- [ ] `uv run mypy` (strict), `uv run ruff check`, `uv run pytest` all exit 0.
- [ ] Zero vendor token in the adapter/factory surface or docstrings; `grep -ri posthog` over the new files is clean (source-level; PY8 does the built-artifact scan).

## Technical notes

- **CRITICAL — Python is ADAPTER-DRIVEN, TS E7 was a STANDALONE CLIENT.** The single biggest reframe vs the TS reference: TS node built its OWN `NodeAnalytics` client (shape A) + `NodeNoop` null-object because TS node was NOT adapter-driven. **Python's provider already exists (PY2/PY3) and calls `adapter.capture(event)`** — so PY4 builds the real `AnalyticsAdapter`, and the unkeyed no-op is the ALREADY-SHIPPED seam `NoopAdapter` the factory injects. Do NOT port `NodeNoop` — there is no separate client to no-op. Read `python/src/analytics_kit/{provider,adapter,noop,factory,config}.py` to see exactly what the adapter receives.
- **What the adapter receives (from the shipped provider, `provider.py`):** a `NeutralEvent` with `event`, `distinct_id`, `dedupe_id` (uuid4 fallback already applied), `properties` (super-props already merged, allowlist already gated, taxonomy already validated), `timestamp`, and `internal_kind` (`None` for consumer captures; `"set_traits"`/`"set_group_traits"` for the trait/group verbs). The neutral wrapper keys are already in `properties`: `set`/`set_once` (from `SET_KEY`/`SET_ONCE_KEY`), `group_type`/`group_key`/`group_set` (from `GROUP_TYPE_KEY`/`GROUP_KEY_KEY`/`GROUP_SET_KEY`). PY4-S3's wire-mapper reads these + `internal_kind` and renames to wire keys.
- **CONTRACT reference (port TO):** `ts/packages/node/src/node-analytics.ts` (the capture entry + config-selection shape) — but realize it as an ADAPTER, not a client. **DE-BRAND FROM (idiom only):** `posthog-python/posthog/client.py` (the capture/enqueue idiom). The provider surface is the TS lib's own; posthog-python informs enqueue/threading idiom only.
- **Two-piece factory selection** (PY2-S3, TS `E7-S6`): the seam `create_analytics(config, adapter=None)` is generic and never imports a target. The target module reads `config.key`, builds the server adapter, and the consumer/target passes it in (or a thin target-entry does). Unkeyed ⇒ the default `NoopAdapter`. This story adds the target-side selection, not a seam change.
- **⚠ SEAM-IMPORT FENCE — do NOT add `queue`/`threading`/`atexit`/`asyncio`/`concurrent.futures` imports to `factory.py` (or any seam module).** `tests/test_sync_seam.py:145-177` runs an `ast` fence over `_SEAM_MODULES = ("provider", "config", "factory", "noop", "adapter", "client")` asserting none of them import those five modules — the delivery machinery is the server-capture cycle's scope, and the test comment explicitly reserves it for the NEW target modules. The `config.key`→server-adapter selection therefore MUST live in the NEW target module (its own file), NOT be wired by adding imports to the fenced `factory.py`. `config.py` is also fenced, but adding plain `str | None` fields imports nothing — safe. If the selection is done by a thin target-entry that the consumer calls, `factory.py` stays untouched; that is the intended shape.
- **`send` is the neutral string-bodied primitive — batch delivery does NOT route through it.** — architect (2026-07-10, dedicated consult, high): the SHIPPED `send(url, method, headers, body: str | None) -> NeutralResponse` is the neutral transport primitive (a JSON/string body); the gzipped BATCH delivery is adapter-internal and does NOT go through `send` (PY4-S3 owns it, via an injectable adapter-owned transport). This mirrors the twice-locked TS seam decision (binary bodies live below the neutral SPI). Leave `send` as the honest neutral primitive; PY4-S3 documents that batch delivery deliberately bypasses it. Do NOT widen `send` to `bytes`.
- **Neutrality lesson — docstrings ship** vendor-neutral; wire vocab (none yet in S1) will be `_WIRE_*`-confined in PY4-S3.

## Shipped

> Captured by `implement-epics` on 2026-07-10.

- **Files added:** `python/src/analytics_kit/server/adapter.py` (`ServerAdapter` + `EventSink` + `_BufferSink`), `server/__init__.py` (`create_server_analytics` target-entry), `version.py`, `tests/test_server_adapter.py`
- **Files changed:** `config.py` (+`ingest_host`/`ingest_path`), `__init__.py` (exports `ServerAdapter`, `create_server_analytics`, `__version__`)
- **New public API:** `ServerAdapter` (implements the shipped `AnalyticsAdapter` SPI; `capture` enqueues to an injected `EventSink`), `create_server_analytics(config)` (the `config.key`→server-adapter target-entry; unkeyed ⇒ seam `NoopAdapter`, bar B), `EventSink = Callable[[NeutralEvent], None]`
- **Tests added:** structural conformance, enqueue-without-re-minting, keyed-vs-unkeyed selection, config no-collision, neutral id/version
- **Commit:** `core-cycle` (message = story title)
- **Reviewer notes:** clean — conformance has teeth (mutating a member breaks the build at the `create_analytics` injection site), the seam-import fence held (12/12; no `queue`/`threading` in fenced modules), `"granted"` default consent sound (inert SPI backing; the provider's `_opted_out` is the real gate), `send` stays string-bodied.
- **Cross-story seams exposed:** **S2** injects a **queue-backed sink** into `ServerAdapter(sink=...)` BY CONSTRUCTION — no adapter reshaping; the `queue`/`threading`/`atexit` imports land in a NEW target module (NOT the fenced seam). **S2 (and S4) must wire `flush()`/`shutdown()` to the sink's drain** — they're empty passthroughs now, and the provider delegates straight to them. **S3**'s wire-mapper reads what `capture` enqueues (the already-minted `NeutralEvent`); the injectable `Transport` lands on the adapter constructor (gzip batch bypasses the neutral `send`). Config `ingest_host`/`ingest_path` are the endpoint the transport uses.
