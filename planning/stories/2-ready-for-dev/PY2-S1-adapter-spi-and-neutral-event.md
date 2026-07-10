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
  - `NeutralEvent` — a plain `@dataclass` (NOT Pydantic — library-built, trusted-by-construction). **Field order is load-bearing** (a plain dataclass generates a positional `__init__`, and a non-default field cannot follow a defaulted one — see Technical notes): **required fields first, then defaulted.** Exact declaration order:
    - `event: str` (**required**)
    - `distinct_id: str` (**required**)
    - `dedupe_id: str` (**required**, the settled neutral name → wire top-level `uuid`)
    - `properties: NeutralProperties | None = None`
    - `timestamp: datetime | None = None`
    - `internal_kind: InternalKind | None = None` (the structural discriminant for adapter-minted internal events)
  - `NeutralProperties = dict[str, object]` and `NeutralTraits = NeutralProperties` (alias), the shared trait shape the verb paths reuse.
  - `InternalKind` — a `Literal[...]` of the **server-relevant** internal-event kinds only: `"set_traits"`, `"set_group_traits"`, `"group_identify"`. Browser-only kinds (`autocapture`, `pageleave`, `merge`) are N-A server-side — do NOT declare them here (see Technical notes).
  - **Omit** the browser-only fields entirely: no `session_id`, no `is_page_view`, no `enrichment_profile` (all browser-substrate concerns, N-A server-side — DOCUMENTED omission, not a silent drop).
- `analytics_kit/adapter.py`:
  - `ConsentState = Literal["granted", "denied", "pending"]` (declared for parity/no-op; server consent is a weakened instance switch — PY2-S2).
  - `NeutralResponse` — a plain `@dataclass` (`status: int`, `body: str`), the return type of the SPI's transport primitive (so the noop returns an empty one, never `None` where a response is typed — see Technical notes).
  - `AnalyticsAdapter` — a `typing.Protocol` (structural, NOT an ABC), **capture-only + lifecycle**: the single `capture(event: NeutralEvent)` data verb + `flush`/`shutdown` + the transport/consent/library-id primitives (see Technical notes for the pinned member list; `set`/`group` are NOT adapter verbs — the provider mints those events and routes them through `capture`, per the Option-A ruling). Leave it a **plain** `Protocol` — NOT `@runtime_checkable` (PY2-S3 selects by supplied-vs-`None`, not `isinstance`; see Technical notes).
- `analytics_kit/ports.py`:
  - `FeatureFlagPort` and `SessionReplayPort` — minimal `Protocol` sketches (the Python analog of TS `ports.ts`), NOT frozen contracts. Declared so the feature-flags UPCOMING cycle FILLS a pre-declared slot rather than widening the seam.
- Re-export the public types (`NeutralEvent`, `NeutralProperties`, `NeutralTraits`, `InternalKind`, `ConsentState`, `NeutralResponse`, `AnalyticsAdapter`, `FeatureFlagPort`, `SessionReplayPort`) from `analytics_kit/__init__.py`. (A consumer writing a backend adapter needs `AnalyticsAdapter`/`NeutralEvent`/`NeutralResponse`/`ConsentState`; `InternalKind` rounds out the neutral-event surface.)

### Out

- The provider/client contract + the server-shaped verb surface + consent switch — **PY2-S2**.
- The config + factory + `NoopAdapter` — **PY2-S3**.
- The sync-client + background-thread scaffolding — **PY2-S4**.
- Any wire mapping (`dedupe_id → uuid`, `$set`/`$set_once`, the `{api_key, batch, sent_at}` envelope) — adapter-internal, **PY4**. This story fixes only the neutral field names + the discriminant *set*, not the wire mapping.
- Any flag/replay behavior — the ports are type-only, always `None` this release.
- Allowlist / taxonomy — those are a bespoke function + registry in **PY3**, not on this SPI.

## Acceptance criteria

- [ ] `NeutralEvent` is a `@dataclass` with `event`/`distinct_id`/`dedupe_id` **required and declared first** (in that order), then `properties`/`timestamp`/`internal_kind` optional-with-default — required-before-defaulted so the generated `__init__` is valid. It is NOT a Pydantic model.
- [ ] `InternalKind` is a `Literal` of exactly `"set_traits"`, `"set_group_traits"`, `"group_identify"` — no browser-only kinds.
- [ ] `NeutralEvent` carries **no** `session_id` / `is_page_view` / `enrichment_profile` (browser-only, N-A server-side).
- [ ] `AnalyticsAdapter` is a plain `typing.Protocol` (not `abc.ABC`, not `@runtime_checkable`); a class satisfies it structurally without importing/subclassing it (proven by a mypy-level conformance check in the tests the builder writes — e.g. a `def _conforms(a: AnalyticsAdapter) -> None: ...` fed the noop).
- [ ] `NeutralResponse` is a plain `@dataclass` (`status: int`, `body: str`), NOT Pydantic; the SPI's transport primitive is typed to return it.
- [ ] `FeatureFlagPort` / `SessionReplayPort` exist as minimal `Protocol` sketches, exported, with no runtime behavior.
- [ ] The public types are importable from `analytics_kit` (`from analytics_kit import NeutralEvent, AnalyticsAdapter, ...`).
- [ ] `uv run mypy` (strict), `uv run ruff check`, `uv run pytest` all exit 0.
- [ ] Zero vendor token anywhere a consumer can observe — type names, field names, **and docstrings** (docstrings ship in the wheel; see Technical notes). `grep -ri posthog analytics_kit/neutral_event.py analytics_kit/adapter.py analytics_kit/ports.py` is clean.

## Technical notes

- **CONTRACT reference vs IDIOM reference (make this explicit).** The CONTRACT is the shipped TS seam: `ts/packages/analytics-kit/src/{neutral-event,adapter,ports}.ts` (+ `ts/packages/node/src/node-analytics.ts` as the server baseline). `posthog-python/` (repo root) informs Python idiom / threading / de-branding ONLY — the frozen-15 facade, consent tri-state, taxonomy, and allowlist **do not exist in posthog-python**. Port *to* the TS contract; de-brand *from* posthog-python.
- **Protocol, not ABC.** — architect (2026-07-09, Cluster 2, high): structural typing matches the TS `interface`-based SPI and lets a backend adapter satisfy the seam WITHOUT importing/subclassing a library base (the coupling the neutral seam exists to avoid). Rejected: `abc.ABC` + `@abstractmethod` — nominal inheritance tightens coupling.
- **`@runtime_checkable` decision — leave it OFF (S1↔S3 coordination, resolved).** PY2-S3's factory selects the adapter by a supplied-vs-`None` argument check (`adapter if adapter is not None else NoopAdapter()`), NOT `isinstance` — so `AnalyticsAdapter` stays a **plain** `Protocol` this cycle (S3's own note confirms it prefers to avoid `isinstance`). Do NOT add `@runtime_checkable` speculatively; it is only added if a future story genuinely needs a runtime `isinstance` gate, and only then (a `@runtime_checkable` Protocol's `isinstance` checks member *presence*, not signatures, so it buys little here). The S1 conformance test proves structural satisfaction at type-check time (mypy), not via `isinstance`.
- **`NeutralResponse` home.** The plain-`@dataclass` transport response the SPI's transport primitive returns is declared in `adapter.py` alongside the SPI (it is the SPI's own return type). The `NoopAdapter` (PY2-S3) imports it to build its empty `NeutralResponse(status=0, body="")`. Keep it a plain dataclass, not Pydantic (library-built).
- **SPI member list — CAPTURE-ONLY + LIFECYCLE (architect ruling 2026-07-09, Option A). These signatures are the SINGLE SOURCE OF TRUTH; S2/S3/S4 reference them, they don't re-declare.** The seam's ONE data-carrying verb is `capture(event: NeutralEvent)`; `set`/`group` are NOT raw-arg SPI methods (see the ruling in Technical notes). The provider mints the `set_traits`/`set_group_traits`-kinded `NeutralEvent` and routes it through `capture(event)`, so the adapter surface shrinks to capture-plus-lifecycle — the maximally-neutral, zero-coupling surface that bar A rewards. Pin exactly (all strict-typechecked as realizable):
  - `capture(self, event: NeutralEvent) -> None` — the sole data verb (consumer captures AND provider-minted `set_traits`/`set_group_traits`/`group_identify` internal events all arrive here, discriminated by `event.internal_kind`).
  - `flush(self) -> None` / `shutdown(self) -> None` (sync — the Python analog of TS's `Promise<void>`; see PY2-S4)
  - the transport primitive (a neutral HTTP send — DOM-free/framework-free, the Python analog of TS's neutral `fetch`); **sketch signature only** — pin a plausible one (e.g. `send(self, url: str, method: str, headers: dict[str, str], body: str | None = None) -> NeutralResponse`) returning a plain-`@dataclass` `NeutralResponse` (see the noop pin in PY2-S3), so the noop returns `NeutralResponse(status=0, body="")` rather than `None` where a response is typed. PY4 finalizes the exact shape (non-breaking to the SPI). Confirm with `posthog-source-guide`/architect if unclear when the builder reaches it — but do NOT block PY2 on it; sketch is enough.
  - `get_consent_state(self) -> ConsentState` / `set_consent_state(self, state: ConsentState) -> None`
  - `get_library_id(self) -> str` / `get_library_version(self) -> str`
  - **Do NOT add** `set`/`group` raw-arg verbs (Option A drops them — they'd pointlessly duplicate the capture path for a stateless server seam and import browser-shaped identity surface), nor any browser-only member (`register`/`unregister`/`reset`/`get_distinct_id`/`get_persisted_property`/`set_persisted_property`/`alias`/`get_custom_user_agent`) — persistence/identity primitives with no server home.
- **Capture-only adapter SPI — set/group are provider-minted events, NOT adapter verbs (architect ruling 2026-07-09, refiner catch, Option A).** The TS `AnalyticsAdapter` carries `identify`/`group`/`register`/`alias` because the *browser* target has stateful persistence-backed identity mechanics (device id, super-prop store, consent-gated persistence — `adapter.ts:30-42`). The Python seam is the stateless server path, where set/group ARE just kinded events on the one queue — exactly what the TS *node* target does (`node-analytics.ts:144-194`: `setTraits`/`setGroupTraits` mint an `internalKind`-tagged `NeutralEvent` via `enqueueInternal` and route it through the SAME queue as capture; the node client IS its own adapter, so that private minting is not the seam). So the Python adapter SPI is **capture-plus-lifecycle only**: the *provider* (PY2-S2) owns the once-vs-set_once intent, the `${group_type}_${group_key}` distinct-id composite, and the mint of the `set_traits`/`set_group_traits`-kinded `NeutralEvent`, then hands it to the single `adapter.capture(event)`. This keeps `internal_kind` visible on the one artifact that crosses the seam (the event) — where PY4's wire-mapper reads it — rather than buried in adapter internals, and shrinks the adapter to the zero-coupling surface bar A rewards. Rejected (Option B): raw-arg `set`/`group` on the SPI — duplicates the capture path for a stateless seam and imports browser-shaped identity surface the node adapter has no reason to hold.
- **`InternalKind` set is server-scoped; the `$set`/`$set_once` wire mapping is PY4.** The TS `internalKind` union is `set_traits|set_group_traits|group_identify|merge|autocapture|pageleave`. Server-relevant subset only: `set_traits`, `set_group_traits`, `group_identify`. This story declares the *field + literal set* so the discriminant exists (adapter-minted internal events key off it, NOT the event name — the R1 lesson that a consumer event literally named `set_traits` under an untyped taxonomy must not be misrecognized). How `set(once=)` maps to `$set` vs `$set_once`, and `dedupe_id → uuid`, are **wire-mapper** concerns → PY4, not PY2.
- **`NeutralEvent` is plain `@dataclass`, NOT Pydantic.** — architect (2026-07-09, Cluster 2): the event is library-built and (in PY3) allowlist-gated, so it is trusted-by-construction — per-event Pydantic is throughput cost for zero safety gain. Pydantic is ONLY at the config-parse boundary (PY2-S3).
- **Dataclass field order is mandatory, not cosmetic (refiner catch).** A plain `@dataclass` synthesizes a positional `__init__`; a required (no-default) field declared *after* a defaulted one is a `TypeError: non-default argument follows default argument` at class-definition/import time — verified empirically. So the three required fields (`event`, `distinct_id`, `dedupe_id`) MUST be declared before the three defaulted ones (`properties`, `timestamp`, `internal_kind`). This diverges from the TS interface's member order (TS interfaces have no positional constructor, so order is free there); do NOT mirror the TS field order. If a future field is required, it goes in the required block; if defaulted, the defaulted block — the two blocks never interleave.
- **Ports are sketch, not frozen** (TS `E2-S6` precedent): the smallest plausible `Protocol` that proves the slot exists and typechecks. Freezing waits until a real flag/replay adapter needs it (the feature-flags UPCOMING cycle). Never fold flags/replay into the capture verbs.
- **Neutrality lesson from PY1 — docstrings ship.** Every module/class/function docstring is runtime-observable and lands in the wheel, so it must be vendor-neutral (no `posthog` token). Only dev-only `#`-comments may carry `# de-branded from posthog's …` provenance (PY8's `ast` scan exempts `#`-comments but not docstrings).

## Shipped

<!-- Captured by implement-epics on close. -->
