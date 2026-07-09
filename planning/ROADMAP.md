# Roadmap — analytics-kit

Last updated: 2026-07-08 — E8 (query) shipped; NOW = E9–E11

## Status

Pre-1.0. The vendor-neutral **`core`** seam is v1 (E1–E3 shipped); the **browser target** (E4 identity, E5 transport, E6 capture/enrichment), the **node server target** (E7 capture), and the **query client** (E8 — read side, KPI primitives + HTTP adapter + warehouse-stub bar-A proof) are capability-complete for R1. NOW holds the remaining epics — **E9–E11** (react binding, example consumer, adoption audit) — all committed for the current build push. Closed epics archive to [`epics/done/`](epics/done/); narrative lives in [`planning/HISTORY.md`](HISTORY.md).

## Sequencing

NOW holds the epics committed for the current build push; **`/implement-epics all` builds every NOW epic**, in dependency order. Ordering is driven by each epic's `blocked_by` graph — epics are the unit of work, not grouped into area-cycles. Prioritization is measured against the SOTA / `posthog-js`-capability bar.

Dependency graph (E1–E3 done):

- `E4` (identity) → `E5` → `E6` (capture) → `E9` (react)
- `E7` (node) and `E8` (query) depend only on the shipped core seam — no wait on the E4→E6 chain
- `E10` (example consumer) needs E6/E7/E8/E9; `E11` (audit) closes after E10

A valid build order honoring every `blocked_by`: **E4 → E5 → E6 → E7 → E8 → E9 → E10 → E11**.

## NOW

Every remaining epic is committed. `/implement-epics all` builds them in the dependency order above.

- **[E4-ID-identity-persistence](epics/done/E4-ID-identity-persistence.md)** *(done)* — anonymous UUIDv7 distinct id + separate device id, config-selectable persistence (`cookie` | `localStorage+cookie` | `memory`), cross-subdomain cookie domain/scope, anonymous→identified merge (rides `identify()`; identity state adapter-internal), super-property registration (allowlist-gated at registration), session id assignment + expiry, durable tri-state consent (`granted`/`denied`/`pending`, DNT-folded), and `reset()`.
- **[E5-CAP-transport](epics/done/E5-CAP-transport.md)** *(done)* — batching (time + size trigger) + gzip compression (native `CompressionStream` + fflate fallback), retry with exponential backoff+jitter (network/5xx-only), offline queue that survives reloads (the one BRIEF §4 gap PostHog doesn't fill), fetch→XHR→sendBeacon + keepalive/unload drain, config-supplied ingest host/path, `dedupeId`→wire `uuid`, client rate-limiter + neutralized back-pressure, bot/crawler filtering.
- **[E6-CAP-capture-enrichment](epics/done/E6-CAP-capture-enrichment.md)** *(done)* — `track` / `page` / adapter-internal pageleave, fresh-per-event page + UTM/attribution + device/browser/referrer context (each opt-out-able via one structured `enrichment` object), pluggable country source (E3-gated value) + GeoIP disable, DOM autocapture opt-in (default OFF, phone-home removed, sensitive scrub), and per-context capture profiles (`context()` → narrower `ScopedAnalytics`, shared identity/session/transport). No new facade verb — pin held at fifteen.
- **[E7-NODE-server-capture](epics/done/E7-NODE-server-capture.md)** *(done)* — standalone `@analytics-kit/node` client: server-side `capture` (required `distinctId`) + `setTraits`/`setGroupTraits`, caller-suppliable `dedupeId`→wire `uuid` idempotency, in-memory batch queue (drop-oldest) + gzip (`node:zlib`) `{api_key,batch,sent_at}` delivery + 413-halving, shared `enforceAllowlist` privacy path (bar A, one code path), unkeyed whole-stack no-op (bar B), `flush()`/`shutdown()` lifecycle. Frozen-15 pin held.
- **[E8-QRY-query-client](epics/done/E8-QRY-query-client.md)** *(done)* — neutral `AnalyticsQueryClient` (funnel / retention / trend / uniqueCount + `rawQuery(expr: string)` escape hatch, all taxonomy-typed → flat neutral `QueryResult`) in `@analytics-kit/node`; `HttpQueryAdapter` (sync + bounded async poll, Bearer personal-key auth, all wire vocab adapter-internal); `WarehouseQueryAdapter` typed stub = the bar-A proof (two adapters, one interface, seam unchanged); server-only `QueryClientConfig` distinct from ingest; unkeyed `QueryNoop` (bar B). Frozen-15 pin held.
- **[E9-RCT-react-binding](epics/E9-RCT-react-binding.md)** *(planned, ← E6)* — optional React/Next binding: provider + hooks.
- **[E10-CORE-example-consumer](epics/E10-CORE-example-consumer.md)** *(planned, ← E6,E7,E8,E9)* — generic example consumer (invented product) under `examples/`, proving new-app adoption is config-only (bar B).
- **[E11-CORE-adoption-audit](epics/E11-CORE-adoption-audit.md)** *(planned, ← E10)* — README interface→implementation matrix, adopt-in-a-new-app guide, and a bar A / bar B sweep including a vendor/product-name scan.

## UPCOMING

_Empty — everything remaining is committed in NOW._

## LATER

_Empty._

## Cycle history

| Shipped | Closed | Epics |
|---|---|---|
| `core` seam | 2026-07-08 | E1, E2, E3 → [`epics/done/`](epics/done/) |

## How to read this file

- **NOW** holds every epic committed for the current build push (each `*(planned)*` or `*(active)*`); `/implement-epics all` builds them all in `blocked_by` dependency order. **UPCOMING / LATER** hold epics not yet committed to a build push.
- **Epics are the unit of work.** An epic is done when its interface surface is v1 and it's archived to `epics/done/`. No version numbers appear here — versions are git tags, not planning labels.
- **Epic links** point to `epics/<id>.md`; closed epics move to `epics/done/`. Stories live under `stories/1-backlog/ … 5-done/`.
- **Promotion** (NOW↔UPCOMING↔LATER) and re-sequencing are user-driven via `/roadmap`; per-epic execution runs through `/implement-epics`. This file is the single source of truth for the plan; narrative history lives in `planning/HISTORY.md`.
