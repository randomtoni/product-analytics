---
id: PY2-S1-adapter-spi-and-neutral-event
epic: PY2-CORE-python-seam
status: ready-for-dev
area: core
touches: [adapters]
depends_on: []
api_impact: additive
---

# PY2-S1-adapter-spi-and-neutral-event — Adapter SPI `Protocol` + neutral event substrate + capability ports

## Why

The `AnalyticsAdapter` SPI *is* bar A ("provider-swap = one adapter, zero consumer change"), and every other PY2 story references the neutral event shape and the SPI. Fixing this substrate first — the `NeutralEvent` dataclass, the SPI as a structural `Protocol`, and the declared-but-unimplemented capability-port slots — is what keeps the seam's data contract from diverging across the later targets (PY4 capture, PY5 query). This is the Python realization of TS `E2-S1` (neutral event) + `E2-S2` (SPI) + `E2-S6` (ports), folded into one substrate story since Python's substrate is smaller.

## Scope

### In

- `analytics_kit/neutral_event.py`:
  - `NeutralEvent` — a plain `@dataclass` (NOT Pydantic — library-built, trusted-by-construction): `event: str`, `distinct_id: str` (**required**), `properties: NeutralProperties | None = None`, `timestamp: datetime | None = None`, `dedupe_id: str` (**required**, the settled neutral name → wire top-level `uuid`), and `internal_kind: InternalKind | None = None` (the structural discriminant for adapter-minted internal events).
  - `NeutralProperties = dict[str, object]` and `NeutralTraits = NeutralProperties` (alias), the shared trait shape the verb paths reuse.
  - `InternalKind` — a `Literal[...]` of the **server-relevant** internal-event kinds only: `"set_traits"`, `"set_group_traits"`, `"group_identify"`. Browser-only kinds (`autocapture`, `pageleave`, `merge`) are N-A server-side — do NOT declare them here (see Technical notes).
  - **Omit** the browser-only fields entirely: no `session_id`, no `is_page_view`, no `enrichment_profile` (all browser-substrate concerns, N-A server-side — DOCUMENTED omission, not a silent drop).
- `analytics_kit/adapter.py`:
  - `ConsentState = Literal["granted", "denied", "pending"]` (declared for parity/no-op; server consent is a weakened instance switch — PY2-S2).
  - `AnalyticsAdapter` — a `typing.Protocol` (structural, NOT an ABC) carrying the neutral server verbs + the genuinely-neutral platform primitives (see Technical notes for the member list). `@runtime_checkable` ONLY if PY2-S3's factory needs `isinstance` for no-op selection — otherwise leave it a plain `Protocol`.
- `analytics_kit/ports.py`:
  - `FeatureFlagPort` and `SessionReplayPort` — minimal `Protocol` sketches (the Python analog of TS `ports.ts`), NOT frozen contracts. Declared so the feature-flags UPCOMING cycle FILLS a pre-declared slot rather than widening the seam.
- Re-export the public types (`NeutralEvent`, `NeutralProperties`, `NeutralTraits`, `AnalyticsAdapter`, `FeatureFlagPort`, `SessionReplayPort`) from `analytics_kit/__init__.py`.

### Out

- The provider/client contract + the server-shaped verb surface + consent switch — **PY2-S2**.
- The config + factory + `NoopAdapter` — **PY2-S3**.
- The sync-client + background-thread scaffolding — **PY2-S4**.
- Any wire mapping (`dedupe_id → uuid`, `$set`/`$set_once`, the `{api_key, batch, sent_at}` envelope) — adapter-internal, **PY4**. This story fixes only the neutral field names + the discriminant *set*, not the wire mapping.
- Any flag/replay behavior — the ports are type-only, always `None` this release.
- Allowlist / taxonomy — those are a bespoke function + registry in **PY3**, not on this SPI.

## Acceptance criteria

- [ ] `NeutralEvent` is a `@dataclass` with `distinct_id: str` and `dedupe_id: str` **required**; `properties`/`timestamp`/`internal_kind` optional-with-default. It is NOT a Pydantic model.
- [ ] `InternalKind` is a `Literal` of exactly `"set_traits"`, `"set_group_traits"`, `"group_identify"` — no browser-only kinds.
- [ ] `NeutralEvent` carries **no** `session_id` / `is_page_view` / `enrichment_profile` (browser-only, N-A server-side).
- [ ] `AnalyticsAdapter` is a `typing.Protocol` (not `abc.ABC`); a class satisfies it structurally without importing/subclassing it (proven by a conformance check in the tests the builder writes).
- [ ] `FeatureFlagPort` / `SessionReplayPort` exist as minimal `Protocol` sketches, exported, with no runtime behavior.
- [ ] The public types are importable from `analytics_kit` (`from analytics_kit import NeutralEvent, AnalyticsAdapter, ...`).
- [ ] `uv run mypy` (strict), `uv run ruff check`, `uv run pytest` all exit 0.
- [ ] Zero vendor token anywhere a consumer can observe — type names, field names, **and docstrings** (docstrings ship in the wheel; see Technical notes). `grep -ri posthog analytics_kit/neutral_event.py analytics_kit/adapter.py analytics_kit/ports.py` is clean.

## Technical notes

- **CONTRACT reference vs IDIOM reference (make this explicit).** The CONTRACT is the shipped TS seam: `ts/packages/analytics-kit/src/{neutral-event,adapter,ports}.ts` (+ `ts/packages/node/src/node-analytics.ts` as the server baseline). `posthog-python/` (repo root) informs Python idiom / threading / de-branding ONLY — the frozen-15 facade, consent tri-state, taxonomy, and allowlist **do not exist in posthog-python**. Port *to* the TS contract; de-brand *from* posthog-python.
- **Protocol, not ABC.** — architect (2026-07-09, Cluster 2, high): structural typing matches the TS `interface`-based SPI and lets a backend adapter satisfy the seam WITHOUT importing/subclassing a library base (the coupling the neutral seam exists to avoid). `@runtime_checkable` only where PY2-S3's factory needs `isinstance`. Rejected: `abc.ABC` + `@abstractmethod` — nominal inheritance tightens coupling.
- **SPI member list (server-shaped, de-DOM'd).** Port the target-agnostic subset of the TS `AnalyticsAdapter` (`adapter.ts`), keeping the neutral verbs the server uses + the neutral platform primitives, and DROPPING browser-only members. Keep: `capture(event: NeutralEvent) -> None`; `set(distinct_id, traits=None, traits_once=None) -> None` (the server identify/trait verb — see PY2-S2); `group(group_type, group_key, traits=None) -> None`; `flush() -> None` / `shutdown() -> None` (sync, see PY2-S4); the transport primitive (a neutral HTTP send — keep it DOM-free/framework-free, the Python analog of TS's neutral `fetch`); `get_consent_state()`/`set_consent_state()`; `get_library_id()`/`get_library_version()`. **Drop** browser-only SPI members (`register`/`unregister`/`reset`/`get_distinct_id`/`get_persisted_property`/`set_persisted_property`/`alias`/`get_custom_user_agent`) — they are persistence/identity primitives with no server home. The exact transport signature is a **sketch** here; PY4 finalizes it when real delivery lands (non-breaking to the SPI shape). Confirm with `posthog-source-guide` or the architect if the transport-primitive shape is unclear when the builder reaches it — but do NOT block PY2 on it; sketch is enough.
- **`InternalKind` set is server-scoped; the `$set`/`$set_once` wire mapping is PY4.** The TS `internalKind` union is `set_traits|set_group_traits|group_identify|merge|autocapture|pageleave`. Server-relevant subset only: `set_traits`, `set_group_traits`, `group_identify`. This story declares the *field + literal set* so the discriminant exists (adapter-minted internal events key off it, NOT the event name — the R1 lesson that a consumer event literally named `set_traits` under an untyped taxonomy must not be misrecognized). How `set(once=)` maps to `$set` vs `$set_once`, and `dedupe_id → uuid`, are **wire-mapper** concerns → PY4, not PY2.
- **`NeutralEvent` is plain `@dataclass`, NOT Pydantic.** — architect (2026-07-09, Cluster 2): the event is library-built and (in PY3) allowlist-gated, so it is trusted-by-construction — per-event Pydantic is throughput cost for zero safety gain. Pydantic is ONLY at the config-parse boundary (PY2-S3).
- **Ports are sketch, not frozen** (TS `E2-S6` precedent): the smallest plausible `Protocol` that proves the slot exists and typechecks. Freezing waits until a real flag/replay adapter needs it (the feature-flags UPCOMING cycle). Never fold flags/replay into the capture verbs.
- **Neutrality lesson from PY1 — docstrings ship.** Every module/class/function docstring is runtime-observable and lands in the wheel, so it must be vendor-neutral (no `posthog` token). Only dev-only `#`-comments may carry `# de-branded from posthog's …` provenance (PY8's `ast` scan exempts `#`-comments but not docstrings).

## Shipped

<!-- Captured by implement-epics on close. -->
