---
id: PY2-S3-config-factory-and-noop
epic: PY2-CORE-python-seam
status: ready-for-dev
area: core
touches: [adapters]
depends_on: [PY2-S1-adapter-spi-and-neutral-event, PY2-S2-provider-verbs-and-consent]
api_impact: additive
---

# PY2-S3-config-factory-and-noop — Pydantic config, `create_analytics` factory & whole-stack `NoopAdapter`

## Why

The config-selected factory is bar B ("new-app adoption = config only, zero library change") made real — a consumer wires the library by config alone. The whole-stack `NoopAdapter` makes "unkeyed ⇒ silent" a null-object guarantee, not a `disabled` flag threaded through the provider. Config parse is the ONE genuine inbound boundary where Pydantic belongs. This is the Python realization of TS `E2-S4` (factory + noop) with the added Pydantic-at-the-boundary ruling.

## Scope

### In

- `analytics_kit/config.py`:
  - `AnalyticsConfig` — a **Pydantic** model (the one genuine inbound boundary): at least `key: str | None = None` (its presence/absence drives no-op selection) + `super_properties: dict[str, object] | None = None`. Keep it minimal and additively extensible (PY3 adds taxonomy/allowlist, PY4 adds ingest endpoint + queue tuning, PY5 the query config). Do NOT pre-stub later-epic fields.
- `analytics_kit/noop.py`:
  - `NoopAdapter` — a null object implementing the **full** `AnalyticsAdapter` SPI (PY2-S1, capture-only + lifecycle per the Option-A ruling): `capture(event)` does nothing; `flush`/`shutdown` return; the transport primitive returns a neutral empty `NeutralResponse(status=0, body="")` (imported from `adapter.py`, never `None`); `get_consent_state()` returns `"denied"` (typed `ConsentState`); `set_consent_state()` no-ops; `get_library_id()`/`get_library_version()` return the neutral placeholders `"analytics-kit"` / `"0.0.0"` (never a vendor token). **There is NO `set`/`group` on the SPI** (Option A) — do not add them to the noop. **Whole-stack** — nothing reaches the wire.
- `analytics_kit/factory.py`:
  - `create_analytics(config, adapter=None)` — resolves the adapter (supplied arg, else `NoopAdapter` when unkeyed/none), constructs the PY2-S2 provider around it, and returns the provider. Pydantic-parses/validates `config`. **Threads `config.super_properties` into the provider constructor** (the provider merges them into every minted event, PY2-S2) — the factory is where config→provider wiring happens, so do not leave this implicit. When no `key` is configured, the whole stack is the silent no-op.
  - **Adapter selection is a supplied-vs-`None` check, NOT `isinstance`** (`adapter if adapter is not None else NoopAdapter()`) — this is why PY2-S1's `AnalyticsAdapter` stays a plain (non-`@runtime_checkable`) `Protocol`. Do not reach for `isinstance`.
- Public exports from `analytics_kit/__init__.py`: `create_analytics`, `NoopAdapter`, `AnalyticsConfig` (+ the provider type as the return annotation).

### Out

- Any **target** adapter (PY4 server-capture adapter, PY5 query adapter) — the seam factory only exercises selection down to `NoopAdapter`; the real config-driven adapter selection lives in the target modules (PY4/PY5), same two-piece shape as TS.
- The sync-client + background-thread scaffolding the real adapter plugs into — **PY2-S4**.
- Real transport/persistence in any non-noop adapter — PY4.
- Taxonomy/allowlist config fields — PY3 (added additively).

## Acceptance criteria

- [ ] `AnalyticsConfig` is a Pydantic model; parsing an invalid config raises a Pydantic validation error (the one genuine inbound boundary is validated).
- [ ] `create_analytics(AnalyticsConfig())` (no `key`) returns a provider whose captures are silent — a spy on the transport receives nothing; the whole stack is no-op.
- [ ] `create_analytics(config, adapter)` wires the provider to the supplied adapter and delegates to it (generic machinery works with any `Protocol`-satisfying adapter).
- [ ] `NoopAdapter` satisfies the **entire** `AnalyticsAdapter` SPI as silent no-ops; there is **no** `disabled` boolean threaded through the provider.
- [ ] Bar B is demonstrable: a consumer obtains a working (silent) provider by config alone, zero library edit.
- [ ] `uv run mypy` (strict), `uv run ruff check`, `uv run pytest` all exit 0.
- [ ] Zero vendor token in config/factory/noop surface or docstrings; `grep -ri posthog analytics_kit/config.py analytics_kit/factory.py analytics_kit/noop.py` is clean.

## Technical notes

- **Pydantic ONLY at the config-parse boundary.** — architect (2026-07-09, Cluster 2, high): config is the one genuine inbound (consumer-supplied, untrusted-ish) boundary — validate it with Pydantic. `NeutralEvent`/wire/specs stay plain `@dataclass`/`TypedDict` (library-built, trusted). The allowlist is a bespoke function (PY3), NOT Pydantic. Do not reach for Pydantic anywhere else in the seam.
- **Whole-stack null-object, NOT a `disabled` flag.** — architect (2026-07-09) + TS `E2-S4`: posthog-python threads a `disabled` boolean; we deliberately don't — a `NoopAdapter` keeps `if disabled` checks from spreading and makes "unkeyed ⇒ silent" a null-object guarantee. The no-op is whole-stack (no transport, no persistence — server has none anyway).
- **Factory placement vs the target split** (TS `E2-S4` load-bearing): the seam ships the *generic* `create_analytics(config, adapter)` machinery + the `NoopAdapter`, but the seam **never imports a target adapter**. PY4/PY5 target modules read `config.key` to build+inject their own adapter, falling back to the seam `NoopAdapter` when unkeyed. "Selects the adapter from config" = this two-piece shape, not seam-side target imports. PY2-S3 exercises only unkeyed ⇒ `NoopAdapter`.
- **`@runtime_checkable` decision — SETTLED OFF (coordinated with PY2-S1):** the factory selects by a supplied-vs-`None` check, not `isinstance`, so PY2-S1's `AnalyticsAdapter` stays a plain `Protocol` (NOT `@runtime_checkable`). This is resolved, not conditional — do not add `@runtime_checkable` here or ask PY2-S1 to.
- **`NoopAdapter` transport return must satisfy the SPI** (TS `E2-S4` code-shape pin): the transport primitive is typed to return `NeutralResponse` (the plain `@dataclass` declared in `adapter.py`, PY2-S1), so the no-op returns `NeutralResponse(status=0, body="")`, never `None` where a response is typed. Client-identity getters return the neutral `"analytics-kit"` / `"0.0.0"` placeholders, never a vendor token.
- **`AnalyticsConfig` stays minimal** — only what drives no-op selection (`key`) + `super_properties` (PY2-S2 consumes it). Every later area extends it additively; do not pre-stub.
- **CONTRACT vs IDIOM reference:** port the factory/noop SHAPE *to* TS `create-analytics.ts` + `noop-adapter.ts`; de-brand nothing product-specific from posthog-python here (posthog-python has no factory/no-op-null-object of this shape — the config-selected silent-no-op is the library's own posture).
- **Neutrality lesson from PY1 — docstrings ship** vendor-neutral; only `#`-comments carry provenance.

## Shipped

<!-- Captured by implement-epics on close. -->
