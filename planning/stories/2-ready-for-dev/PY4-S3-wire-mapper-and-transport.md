---
id: PY4-S3-wire-mapper-and-transport
epic: PY4-NODE-server-capture
status: ready-for-dev
area: node
touches: [adapters]
depends_on: [PY4-S2-batch-consumer-thread]
api_impact: additive
---

# PY4-S3-wire-mapper-and-transport — Adapter-internal wire-mapper, gzip envelope & injectable transport

## Why

Turns the buffered queue into real delivery: an adapter-internal wire-mapper lays each `NeutralEvent` out into the server batch shape, the batch is gzipped and POSTed to a config-supplied endpoint via an injectable transport. This is where the `dedupe_id → wire uuid` mapping and the `{api_key, batch, sent_at}` envelope live — all adapter-internal, `_WIRE_*`-confined, none of it on the neutral surface. It is the Python realization of TS `E7-S4` (batch delivery wire) + `E7-S5` (trait/group wire shape).

## Scope

### In

- An adapter-internal wire-mapper (in the server-adapter module — e.g. `analytics_kit/server/wire_mapper.py`): `NeutralEvent → wire` batch-message shape. Maps the neutral `dedupe_id` to the wire top-level `uuid` (verbatim, **NOT `$insert_id`**); carries `distinct_id`, `event`, `properties`, `timestamp`. Adapter-internal — no key here reaches the neutral surface.
- **Trait/group wire shape** (folding in TS `E7-S5`): read the neutral `internal_kind` discriminant + the neutral wrapper keys the provider already set — `set`/`set_once` (person-props) and `group_type`/`group_key`/`group_set` (group) — and rename to the wire keys `$set`/`$set_once`/`$groups` (or the settled wire shape), NESTED in `properties` (the TS-node shape, not the browser top-level lift). Recognition keys off `internal_kind`, NEVER the event name (the R1 discriminant discipline). **Emit only the bag that is present:** the provider's `set()` mints a SINGLE key — `set` OR `set_once`, never both (see `provider.py:137-147`, `key = SET_ONCE_KEY if once else SET_KEY`) — so the mapper emits `$set` xor `$set_once`, guarding each with an `in properties` check (TS `wire-mapper.ts:77-104`). Never synthesize an absent bag.
- The batch envelope: `{api_key, batch: [...wire messages], sent_at}` — a `_WIRE_*`-confined shape — POSTed to the **config-supplied endpoint** (ingest host + path; NO vendor host/region default). The `/batch/`-style path is adapter-internal.
- Gzip the batch body (default on) with the stdlib `gzip`/`zlib` (`gzip.compress(...)` → `bytes`); set the wire `Content-Type: application/json` + `Content-Encoding: gzip` headers. Fall back to uncompressed JSON (omit `Content-Encoding`) if gzip yields nothing.
- **Injectable transport on the ADAPTER CONSTRUCTOR** (the architect ruling — see Technical notes): the server adapter's `__init__` takes an optional transport, typed against a **minimal adapter-owned `Transport` Protocol** (e.g. `post(url, headers, body: bytes) -> NeutralResponse`), defaulting to a stdlib/`requests`-style implementation. Gzip + the POST happen INSIDE this transport path — **NOT through the seam's `send(str)` primitive.**
- All wire vocabulary (`$set`/`$set_once`/`$groups`, `{api_key, batch, sent_at}` keys, gzip content-type, the `/batch/` path, `uuid`) lives in `_WIRE_*` module-level constants — the PY8 `ast` scan asserts confinement.

### Out

- The queue / defaults / drop-oldest / thread (PY4-S2 — this story consumes the injected delivery callback).
- Retry classification / fetch-failure normalization / 413-halving — **PY4-S4** (this story does the happy-path map+gzip+POST; the failure paths ride PY4-S4).
- Public `flush()`/`shutdown()` drive — **PY4-S4**.
- Widening the seam `send` to `bytes` — explicitly NOT done (the architect ruling: gzip stays below the SPI).
- Browser wire toggles (geoip/autocapture/pageview) — N-A server-side.

## Acceptance criteria

- [ ] Each flushed `NeutralEvent` maps to the wire shape with its `dedupe_id` at the top-level `uuid`; a capture retried with the same caller `dedupe_id` produces the same `uuid` (idempotent). `$insert_id` is NOT emitted.
- [ ] A trait event (`internal_kind="set_traits"`) maps its `set`/`set_once` wrapper to `$set`/`$set_once` nested in `properties`; a group event (`internal_kind="set_group_traits"`) maps `group_type`/`group_key`/`group_set` to the wire group shape. Recognition is by `internal_kind`, NOT the event name (a consumer event named `set_traits` with `internal_kind=None` is NOT mistreated).
- [ ] A batch is gzipped and POSTed as `{api_key, batch, sent_at}` to the config-supplied endpoint; no vendor hostname/region is defaulted; gzip falls back to raw JSON (omitting `Content-Encoding`) when it yields nothing.
- [ ] The injectable transport lives on the adapter constructor (typed against the adapter-owned `Transport` Protocol), defaulting to a stdlib/`requests` impl; gzip + POST happen inside it, **NOT** through the seam `send(str)` primitive.
- [ ] All wire vocabulary is `_WIRE_*`-confined and adapter-internal — zero wire vocab reaches the neutral surface (bar A). `grep -ri posthog` clean.
- [ ] `uv run mypy` (strict), `uv run ruff check`, `uv run pytest` all exit 0.

## Technical notes

- **CONTRACT reference (port TO):** `ts/packages/node/src/{wire-mapper,send-batch,gzip}.ts` — the `{api_key, batch, sent_at}` envelope, `dedupe_id`→top-level `uuid` (NOT `$insert_id`), gzip-default-on with raw fallback, config endpoint no-vendor-default. `E7-S5` for the trait/group nested-in-`properties` wire shape (`$set`/`$set_once`/`$groups`). **DE-BRAND FROM (idiom only):** `posthog-python/posthog/request.py` (the gzipped POST + `requests.Session` idiom) — idiom/wire, NOT contract.
- **Mapper INPUT is exactly what `provider.py` mints (verified — do NOT assume a different shape).** The `NeutralEvent` the mapper receives (from `neutral_event.py` + `provider.py`): `event: str`, `distinct_id: str`, `dedupe_id: str` (uuid4 fallback ALREADY applied by the provider — the mapper never generates it), `properties: dict[str, object] | None`, `timestamp: datetime | None` (tz-aware UTC), `internal_kind: Literal["set_traits","set_group_traits","group_identify"] | None`. For a consumer `capture`, `internal_kind is None` and `properties` is the merged/gated/typed bag. For `set(...)`, `internal_kind == "set_traits"` and `properties == {"set": traits}` OR `{"set_once": traits}` (single key). For `set_group_traits(...)`, `internal_kind == "set_group_traits"` and `properties == {"group_type": ..., "group_key": ..., "group_set": traits}`. (`"group_identify"` is declared on the `InternalKind` Literal but the provider never mints it this cycle — the mapper handles only the two it produces; an unrecognized `internal_kind` falls through to plain pass-through.) A consumer event literally named `"set_traits"` arrives with `internal_kind is None` and is NOT mistreated (AC covers this).
- **`dedupe_id → uuid`, NOT `$insert_id`** (TS `E7-S4`, architect): the caller idempotency key is the wire top-level `uuid`; `$insert_id` is a separate browser-only random property, never the server dedup key — node emits no `$insert_id`. Same neutral field the seam settled (PY2 `dedupe_id`), so cross-target idempotency holds. Map `dedupe_id` verbatim onto wire `uuid` — no re-generation (the provider already applied the fallback).
- **Gzip + POST are adapter-internal; injectable transport on the CONSTRUCTOR.** — architect (2026-07-10, dedicated consult, high confidence, no user gate): the SHIPPED seam `send(url, method, headers, body: str | None)` is the neutral STRING-bodied transport primitive — the gzipped BATCH delivery does NOT route through it (mirrors the twice-locked TS seam decision that binary bodies live below the neutral SPI: `adapter.ts` `body?: string`; the `E5-S2`/`E5-S6` seam notes). Do NOT widen `send` to `bytes`; do NOT drop gzip. Instead: the server adapter owns a private transport path (its own gzip→POST), and the CONSUMER-injectable transport is a constructor parameter typed against a **minimal adapter-owned `Transport` Protocol** (the analog of TS node's injectable `fetch` / posthog-python's `session`) — NOT the seam `send`. The injected transport is typed against the adapter's own Protocol, never a vendor/library type (`requests.Session` must not leak across the seam). Consumer wiring already flows through `create_analytics(config, adapter)` — a consumer who wants a custom transport constructs the server adapter with it injected. Add a docstring line on the seam `send` (in `adapter.py` — the shipped `AnalyticsAdapter` Protocol) marking it the neutral string-bodied primitive that batch delivery deliberately bypasses (kills the "vestigial" read). **Fence note:** `adapter.py` is a fenced seam module (`test_sync_seam.py`) — a docstring edit is safe (imports nothing), but do NOT add any `threading`/`queue`/`gzip`/transport import there; the `Transport` Protocol + default transport + gzip live in the NEW target module(s), not the seam.
- **Gzip primitive:** stdlib `gzip.compress(body, mtime=0)` (deterministic, if tests assert bytes) → `bytes` that drop onto the transport body. Stdlib, zero new dep (the posthog-python `requests` dependency is an idiom reference; prefer stdlib `urllib` for the default transport unless a story-time reason favors `requests` — builder call, but keep the DEFAULT dep-light and the injection point open).
- **Wire vocab `_WIRE_*`-confined** (PY8 `ast` scan): `$set`/`$set_once`/`$groups`, `{api_key,batch,sent_at}` keys, the `/batch/` path, gzip content-type — all module-level `_WIRE_*` constants inside the adapter, never on the neutral `AnalyticsAdapter`/`NeutralEvent` surface. This is the confinement PY8 asserts and the R1 `HogQLQuery`-leak lesson.
- **Neutrality lesson — docstrings ship** vendor-neutral; wire vocab confined.

## Shipped

<!-- Captured by implement-epics on close. -->
