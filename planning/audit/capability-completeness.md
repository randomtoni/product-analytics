# Capability-completeness audit — E11-S4

> This document lives in `planning/` (dev tooling), which is **exempt** from the vendor-name
> scan (`scripts/neutrality-scan.ts`). Therefore by-role posthog-js references with `file:line`
> are allowed here and here only — they never ship into `packages/**` or any shipped doc.
>
> **What this audit proves:** nothing in the BRIEF §Capability contract (`planning/BRIEF.md`
> lines 72–139) is LOST by depending on `analytics-kit`. Every contract line maps to a real
> shipped neutral export/module. Anything the contract lists but the library does not implement
> is an **explicit by-design omission** (BRIEF §"Explicitly OUT") backed by a declared extension
> seam — never a silent gap.
>
> **Scope + method (architect-locked, 2026-07-09):** this is primarily a PROSE judgment mapping —
> "nothing is lost" is a semantic claim no assertion can decide. It is paired with a cheap,
> high-value GATED slice: an export/type-PRESENCE assertion over the built `dist`
> (`examples/fernly/src/capability-presence.ts`) that fails `typecheck` on any rename/drop/
> signature-change of the frozen surface — the staleness tripwire that keeps this table honest.
> The gate checks PRESENCE + SHAPE only; MEANING stays here + in reviewer judgment. Scoped to the
> BRIEF contract, NOT everything PostHog ships.
>
> posthog-js reference checkout: local `posthog-js/` at its current HEAD.

---

## Frozen surface counts (verified against shipped source + `dist`)

| Surface | Members | Source of truth | Gated in |
|---|---|---|---|
| `AnalyticsProvider` (client, frozen-15) | 13 methods + `flags?` + `replay?` = **15** | `packages/analytics-kit/src/analytics-provider.ts` | `dist/index.d.ts` (type-only export) |
| `NodeAnalytics` (server) | `capture` / `setTraits` / `setGroupTraits` (+ `flush` / `shutdown`) | `packages/node/src/node-analytics.ts` | `packages/node/dist/index.d.ts` (type-only) |
| `AnalyticsQueryClient` (query) | `funnel` / `retention` / `trend` / `uniqueCount` / `rawQuery` = **5** | `packages/node/src/query/query-client.ts` | `packages/node/dist/index.d.ts` (type-only) |

`AnalyticsProvider` / `NodeAnalytics` / `AnalyticsQueryClient` ship as **type-only** exports
(`export { type … }`, verified in each `dist/index.d.ts`) — no runtime value. Their member
presence is therefore asserted at **typecheck time** (a `keyof`-equality check against the
`dist` types), NOT via a runtime `Object.keys` inspection (an interface has no runtime object).

---

## 1. Client capture interface — `AnalyticsProvider` (BRIEF §1)

Frozen-15. Source: `packages/analytics-kit/src/analytics-provider.ts`.

| BRIEF §1 line | Neutral export / member | posthog-js reference (by role) |
|---|---|---|
| `track(event, props)` | `AnalyticsProvider.track` → `AnalyticsProviderImpl.track` → `adapter.capture(buildEvent(...))` | `packages/browser/src/posthog-core.ts:1292` — `capture(event_name, properties?)`, the single named-event entry; super-prop merge at `:1577`/`:1599` |
| `identify(id, traits, traitsOnce)` | `AnalyticsProvider.identify` → `adapter.identify(id, traits, traitsOnce)` | `packages/browser/src/posthog-core.ts:2511` — `identify(...)`; anon→identified bind gated on `USER_STATE_ANONYMOUS` at `:2553` |
| `page(name?, props?)` | `AnalyticsProvider.page` → `adapter.capture(buildEvent(name ?? RESERVED_PAGE_EVENT, …, isPageView))` | `packages/browser/src/posthog-core.ts:1571` → `page-view.ts:77` `doPageView` (manual pageview = `capture('$pageview', …)`) |
| `group(type, key, props)` | `AnalyticsProvider.group` → `adapter.group(type, key, props)` | `packages/browser/src/posthog-core.ts:2745` — `group(groupType, groupKey, props?)` |
| `reset()` | `AnalyticsProvider.reset` → `liveAdapter.reset(options)` (routes to LIVE adapter so logout-under-opt-out still clears identity) | `packages/browser/src/posthog-core.ts:2938` — `reset(...)`; new anon id via `uuidv7()` at `:2981` |
| `setTraits(traits, once?)` | `AnalyticsProvider.setTraits` → `adapter.identify(currentDistinctId(), …)` | `packages/browser/src/posthog-core.ts:2634` — `setPersonProperties(...)` |
| `register` / `unregister` (super-properties, E4-S7) | `AnalyticsProvider.register` / `.unregister` → `adapter.register/unregister` (gated at the one consumer super-prop source) | `packages/browser/src/posthog-core.ts:1721` `register(...)`, `:1817` `unregister(...)`; storage `posthog-persistence.ts:103` |
| `optIn()` / `optOut()` / `hasOptedOut()` | `AnalyticsProvider.optIn` / `.optOut` / `.hasOptedOut` → `liveAdapter.setConsentState(...)` + active-adapter swap | `packages/browser/src/posthog-core.ts:3840`/`:3917`/`:3995`; manager `consent.ts:20` (`ConsentManager`) |
| `flush()` / `shutdown()` | `AnalyticsProvider.flush` / `.shutdown` → `liveAdapter.flush()` / `.shutdown()` (`Promise<void>`) | `packages/browser/src/posthog-core.ts:3037` `shutdown(...)`; queue driver `request-queue.ts:60` |
| `flags?` (IMPLEMENTED — E12 remote + E13 local) | `AnalyticsProvider.flags?: FeatureFlagPort` — declared on the frozen surface AND now backed by a real adapter (browser remote adapter + node/Python remote + local eval); see §Feature flags below | see §Feature flags below |
| `replay?` (declared-only, BY DESIGN) | `AnalyticsProvider.replay?: SessionReplayPort` — declared, unimplemented this release | see §Explicitly OUT below |

**Adjacent (not on the frozen-15, so no `keyof` pin): `context(name)`** — carried on `RootAnalytics`
(the widened return type in `analytics-provider.ts`), deliberately NOT on `AnalyticsProvider`, so
the 15-member `keyof AnalyticsProvider` pin stays exact. Realizes BRIEF §3's per-context capture
profiles at the consumer surface.

---

## 2. Anonymous identity + persistence (BRIEF §2 — implicit, MUST NOT be forgotten)

Spans `packages/browser/src/**`. Implicit capabilities: present in the shipped browser target,
exercised by the E10 Fernly cross-subdomain-merge-reset test.

| BRIEF §2 line | Neutral module (shipped) | posthog-js reference (by role) |
|---|---|---|
| Generate + persist anon id pre-identify | anonymous-id + identity-resolver (`packages/browser/src/**`, E4-S5) | `packages/browser/src/posthog-core.ts:807` — `get_device_id(uuidv7())`, marks `USER_STATE_ANONYMOUS` `:817` |
| Cross-subdomain persistence via config cookie domain/scope | cookie-domain persistence (`packages/browser/src/**`, E4-S4) | `packages/browser/src/posthog-persistence.ts:113` — `_cross_subdomain` |
| Persistence mode: cookie (default) vs memory | persistence-store modes (`packages/browser/src/**`, E4-S2) | `packages/browser/src/posthog-persistence.ts:189-224` `_buildStorage`; backends `storage.ts` (`cookieStore`/`memoryStore`) |
| `identify()` anon→identified merge, client-side | identity-resolver merge (E4-S6) | `packages/browser/src/posthog-core.ts:2511` `identify(...)`, `:2553` merge gate |
| Session id assignment + expiry | session-id lifecycle (`packages/browser/src/**`, E4-S8) | `packages/browser/src/sessionid.ts:28` `SessionIdManager`, 30-min idle at `:17` |

---

## 3. Auto-enriched context (BRIEF §3 — implicit, each opt-out-able)

Spans `packages/browser/src/**` (E6). Per-event enrichment resolved through the context profile
(`EnrichmentProfile` on the minted `NeutralEvent`).

| BRIEF §3 line | Neutral module (shipped) | posthog-js reference (by role) |
|---|---|---|
| Page context (current_url, pathname, host, referrer, referring_domain) | context-enrichment port (E6-S3) | `packages/browser/src/utils/event-utils.ts:293` `getEventProperties`; referrer `:194`/`:205`; page context via `page-view.ts:77` |
| UTM auto-parse (source/medium/campaign/term/content) | utm/campaign enrichment (E6-S4) | `packages/browser/src/utils/event-utils.ts:87` `getCampaignParams` |
| Device/browser context (browser, os, device_type, screen+viewport, lib+version) | device context enrichment (E6-S3) | `packages/browser/src/utils/event-utils.ts:313-337` (`$browser`/`$device_type`/`$browser_version`) |
| Per-event timestamp + dedupe id (idempotent retries) | `buildEvent(...)` stamps `timestamp` + `dedupeId` (`analytics-provider.ts`; node mints `dedupeId` too) | `packages/browser/src/posthog-core.ts:1366`/`:1460` `getEventUuid(...)`; server twin `packages/core/src/posthog-core-stateless.ts:1162-1163` |
| pageleave capture (time-on-page / bounce), toggleable | pageleave-unload (E6-S2) | `packages/browser/src/posthog-core.ts:1093` `capture(EVENT_PAGELEAVE, …, sendBeacon)`; gate `capture_pageleave` `:243` |
| Country enrichment: pluggable + disable-GeoIP | pluggable country source (E6-S6); `disableGeoip` flows through `EnrichmentProfile` | (no single posthog-js line — GeoIP is server-side at ingest; the pluggable injection is a neutral-seam addition over the enrichment path at `event-utils.ts:293`) |
| Enrichment opt-outs (each individually) | enrichment-optout config (E6-S5); toggles ride `EnrichmentProfile` | config gates around `packages/browser/src/utils/event-utils.ts:293` |

---

## 4. Transport / reliability (BRIEF §4 — implicit)

Spans `packages/browser/src/**` (E5) + node batch (E7).

| BRIEF §4 line | Neutral module (shipped) | posthog-js reference (by role) |
|---|---|---|
| Batching + compression | request-batch-queue (E5-S2) + compression (E5-S5) | `packages/browser/src/request-queue.ts:9` `RequestQueue`; `request.ts:116` `GZipJS`/`gzipSync`, async `CompressionStream` `:191` |
| Retry with backoff | retry-queue-backoff (E5-S3) | `packages/browser/src/retry-queue.ts:40` `RetryQueue`; jitter-exp backoff `:17` |
| Offline queue (survives reloads) | offline-queue-persistence (E5-S9) | `packages/browser/src/retry-queue.ts:115` `navigator.onLine` gate; `online` listener `:65` |
| sendBeacon / keepalive on unload | transport-selection-keepalive (E5-S6) | `packages/browser/src/request.ts:370` `_sendBeacon`; fetch `keepalive` `:323` |
| First-party reverse-proxy ingestion via config ingest host/path | ingest-transport-config (E5-S1); node `ingestHost` (`create-analytics.ts`) | config-supplied endpoint — neutralized from posthog-js's `api_host` handling in `request.ts` |
| Bot/crawler filtering | bot-crawler-filtering (E5-S7) | `packages/browser/src/utils/blocked-uas.ts:24` `isLikelyBot`; core `bot-detection.ts:103` `isBlockedUA` |
| Per-event dedupe id (idempotent retries) | per-event-dedupe-id (E5-S8); `dedupeId` on `NeutralEvent` | `packages/browser/src/posthog-core.ts:1460` `getEventUuid` |
| Client rate-limiter (429/quota) | client-rate-limiter (E5-S4) | `packages/browser/src/rate-limiter.ts:17` `RateLimiter`; `checkForLimiting` `:95` |
| Per-context capture profiles | per-context-capture-profiles (E6-S8); `context(name)` on `RootAnalytics` applies the named profile | consumer-named contexts — neutral-seam mechanism over `event-utils.ts` enrichment toggles |

---

## 5. Autocapture (BRIEF §5 — opt-in per context, default off)

| BRIEF §5 line | Neutral module (shipped) | posthog-js reference (by role) |
|---|---|---|
| Auto-capture clicks / input-changes / form-submits → element metadata; toggleable per context; default off | autocapture-opt-in (E6-S7), gated per context profile | `packages/browser/src/autocapture.ts:260` `Autocapture`; `_captureEvent` `:386` (`$autocapture`); element metadata `getElementsChainString` `:251` |

---

## 6. Server-side capture interface — `NodeAnalytics` (BRIEF §6)

Source: `packages/node/src/node-analytics.ts`. 3 BRIEF verbs = `capture` / `setTraits` /
`setGroupTraits` (plus lifecycle `flush` / `shutdown`).

| BRIEF §6 line | Neutral member | posthog-js reference (by role) |
|---|---|---|
| `capture(id, event, props)` — server-truth events | `NodeAnalytics.capture` → `queue.enqueue(buildEvent(...))` | `packages/node/src/client.ts:591` `capture(EventMessage)` → `core/src/posthog-core-stateless.ts:459` `captureStateless` |
| `setTraits` — server-side person props | `NodeAnalytics.setTraits` → wire-mapped `[set]`/`[set_once]` | `packages/node/src/client.ts:759` `setPersonProperties(...)` |
| `setGroupTraits` — server-side group props | `NodeAnalytics.setGroupTraits` → `${groupType}_${groupKey}` composite id + `[group_set]` | `packages/node/src/client.ts:2014` `groupIdentify(...)` → `core/src/posthog-core-stateless.ts:524` `groupIdentifyStateless` (synthetic id `:534`) |
| No-op without key | node `createAnalytics` returns `NodeNoop` when `config.key === undefined` | `packages/node/src/client.ts:264` early return on `this.disabled` (missing/invalid key `:177`) |
| Idempotent (dedupe on insert id) | `dedupeId` minted per event (`randomUUID()`), rides the wire `uuid` | `packages/core/src/posthog-core-stateless.ts:1154`/`:1163` `getEventUuid` |

---

## 7. Query interface — `AnalyticsQueryClient` (BRIEF §7)

Source: `packages/node/src/query/query-client.ts`. 5 methods.

| BRIEF §7 line | Neutral member | posthog-js reference (by role) |
|---|---|---|
| `funnel({steps, within, breakdown?})` | `AnalyticsQueryClient.funnel(spec): Promise<QueryResult>` | — (see note below) |
| `retention({cohortEvent, returnEvent, periods, granularity, breakdown?})` | `AnalyticsQueryClient.retention(spec): Promise<QueryResult>` | — |
| `trend({event, aggregation, breakdown?, window})` | `AnalyticsQueryClient.trend(spec): Promise<QueryResult>` | — |
| `uniqueCount({event, window, breakdown?})` | `AnalyticsQueryClient.uniqueCount(spec): Promise<QueryResult>` | — |
| `rawQuery(expr)` — adapter-specific escape hatch | `AnalyticsQueryClient.rawQuery(expr): Promise<QueryResult>` | — |
| First adapter: query API over HTTP (server personal key, config endpoint) | `HttpQueryAdapter` (`packages/node/src/query/http-query-adapter.ts`) | **PostHog HTTP Query API (server) — no posthog-js SDK equivalent** (see note) |
| Future adapter: SQL over consumer warehouse (stubbed) | `WarehouseQueryAdapter` (`packages/node/src/query/warehouse-query-adapter.ts`) — stub, interface-satisfying | — |

> **Note (query has no SDK peer):** the posthog-js JS/Node SDKs are capture/flag clients only —
> they carry NO query/HogQL surface (grep for `HogQL`/query across `packages/node/src` +
> `packages/core/src` returns nothing analytical). The query capability maps to PostHog's
> **server-side HTTP Query API** (`POST /api/projects/:id/query`, HogQL), a product/server-API
> reference — not a posthog-js module. This is the one row whose honest citation is "server HTTP
> Query API, no SDK equivalent," not a `file:line`. Both adapters satisfy ONE `AnalyticsQueryClient`
> interface (bar A already met on the query side — cited by E11-S3).

---

## 8. Feature flags — `FeatureFlagPort` (IMPLEMENTED — E12 remote + E13 local)

> **Status change (E13-S4, 2026-07-10):** feature flags GRADUATED from the "Explicitly OUT" table
> below into a shipped capability. The `FeatureFlagPort` seam (declared in E12-S1) is now backed by
> real adapters across BOTH trees — remote eval (E12) on every target, local (in-process) eval (E13)
> on the server targets. What was a typed extension point is now a realized primitive; the OUT table
> keeps only the three that remain non-goals (session replay, surveys, heatmaps).

Seam: `FeatureFlagPort` (`packages/analytics-kit/src/ports.ts`), surfaced as the optional `flags?`
member of `AnalyticsProvider` (client) and as the standalone flag client (`create-flag-client` in
`ts/packages/node`, `create_flag_client` in `python`). Evaluation strategy (remote round-trip vs.
in-process local eval + remote fallback) is **entirely adapter-internal, behind the one unchanged
`evaluate`** — the E12 seam was never touched (the E13 regression-check invariant).

| Capability | Neutral surface | Present in | posthog-js reference (by role) |
|---|---|---|---|
| **Remote flag eval** (per-call round-trip against a flag-decision endpoint) | `FeatureFlagPort.evaluate(FlagContext) → FlagSet` | **browser** (fetch-on-init adapter, E12-S2) + **node** (per-call round-trip, E12-S3) + **Python server** (blocking round-trip, E12-S4) + **React** hook (E12-S5) | `packages/browser/src/posthog-featureflags.ts` (client) + `packages/node/src/extensions/feature-flags` remote path |
| **Local (in-process) eval** (poll flag DEFINITIONS on an interval, evaluate cohort/rollout/hash rules in-process against `FlagContext` person/group properties, fall back to the remote path for undecidable flags) | SAME `FeatureFlagPort.evaluate` — local-vs-remote is adapter-internal; `onlyEvaluateLocally`/`strictLocalEvaluation`/poll-interval/definitions-endpoint are **adapter config** (bar B), never neutral port parameters | **node** (TS, E13-S1/S2) + **Python server** (E13-S3), at cross-tree hash parity — **absent-by-platform from the browser** (a browser fetches its flags; it does no local eval — a documented final boundary, not a gap) | `packages/node/src/extensions/feature-flags/feature-flags.ts` (`FeatureFlagsPoller` + `matchProperty` + rollout-hash bucketing) + the `posthog-python` server analog |

**Ground-truth + parity proof (E13-S4):** local eval is proven CORRECT, not merely self-consistent —
a loopback `http.Server`/`http.server` (a real socket, both trees) serves canned definitions to the
poller AND a canned remote answer to the shipped round-trip, and the suites assert local eval agrees
with the remote answer per-flag (value + variant + payload). Negative controls (a deliberately-wrong
remote answer, a flipped rollout boundary, a zero-remote-POST assertion) prove the diff BITES. The
**cross-tree hash anchor** — tier 1 `SHA1("some-flag.some_distinct_id") ==
"e4ce124e800a818c63099f95fa085dc2b620e173"`, tier 2 the exact bucketing floats, tier 3 the
`distinct_id_{0..9}` boolean/variant vectors — is asserted byte-for-byte in BOTH the TS-node and
Python suites; a drift in either tree's hash fails its suite. A live privileged-key ground-truth
(diffing local eval against a real backend's own bucketing) is a skip-if-no-key layer; the loopback +
hash-anchor layers are the CC-reachable green path.

**Both bars hold for local eval:** bar A — an adapter that supports only remote (or only local) still
satisfies the one `evaluate`; local eval is a capability an adapter MAY add, never a contract every
adapter must implement. Bar B — enabling/tuning local eval is config-only (a definitions endpoint + a
privileged definition-reading credential select the local-capable adapter), zero library change.

---

## Explicitly OUT this release — typed extension points, BY DESIGN (BRIEF §"Explicitly OUT")

These are the **load-bearing** rows: each converts a raw gap ("we forgot replay") into
documented-intentional scope ("replay is a non-goal with a declared extension seam"). BRIEF line 139
originally listed FOUR here; **feature flags / experiments graduated to implemented (E12 remote +
E13 local — see §8 above)**, so THREE remain OUT. Session replay has a declared port on the frozen
surface today; all three map to a real posthog-js `Extension` (so the omission is deliberate, not an
oversight).

Seams: `packages/analytics-kit/src/ports.ts` (`SessionReplayPort`), surfaced as the optional
`replay?` member of `AnalyticsProvider`. (`FeatureFlagPort` / `flags?` is now IMPLEMENTED — §8.)

| BRIEF §OUT capability | Status in library | Declared seam | posthog-js reference (by role) |
|---|---|---|---|
| **Session replay** | Typed extension point, NOT implemented — by design | `SessionReplayPort` (`ports.ts`) → `AnalyticsProvider.replay?` (declared-only; `keyof` includes `replay`, no instance carries it this release) | `packages/browser/src/extensions/replay/session-recording.ts:39` `class SessionRecording implements Extension` |
| **Surveys** | Typed extension point, NOT implemented — by design | no dedicated port yet — a future port lands as ONE additive `AnalyticsProvider` optional member (same pattern as `flags?`/`replay?`), zero break | `packages/browser/src/posthog-surveys.ts:36` `PostHogSurveys implements Extension` |
| **Heatmaps** | Typed extension point, NOT implemented — by design | no dedicated port yet — future additive optional member (same pattern) | `packages/browser/src/heatmaps.ts:61` `Heatmaps implements Extension` |

> All three remaining omitted capabilities implement the SAME posthog-js `Extension` contract
> (`packages/browser/src/extensions/types.ts`) — evidence that the neutral seam's "declared
> optional port" shape (`flags?`/`replay?`) is the right, uniform place they slot in additively
> when a real adapter first ships one (as feature flags now have — §8). Whether the remaining three
> should share one `Extension`-style neutral contract vs stay bespoke optional ports is a future
> architect call; today they are a documented, seam-backed non-goal, not a silent gap.

---

## Conclusion — nothing in the BRIEF contract is LOST

- **§1 client (frozen-15):** all 13 methods + `flags?`/`replay?` present on `AnalyticsProvider`,
  gated against `dist` types.
- **§2 identity+persistence, §3 enrichment, §4 transport, §5 autocapture (implicit):** all realized
  in `packages/browser/src/**` (E4–E6), exercised by the E10 Fernly example.
- **§6 node:** all 3 verbs (`capture`/`setTraits`/`setGroupTraits`) + no-op + idempotency present on
  `NodeAnalytics`, gated against `dist` types.
- **§7 query:** all 5 methods present on `AnalyticsQueryClient` + both adapters (`HttpQueryAdapter`
  real, `WarehouseQueryAdapter` stub), gated against `dist` types.
- **§8 feature flags:** IMPLEMENTED — `FeatureFlagPort.evaluate` backed by real adapters across both
  trees: remote eval on every target (E12) + local (in-process) eval on the server targets (E13), at
  cross-tree hash parity, browser-absent-by-platform for local. Both bars hold (adapter-swap = zero
  consumer change; config-only enablement).
- **§Explicitly OUT:** the three remaining non-goals (replay, surveys, heatmaps) are
  documented-intentional omissions with declared/patterned extension seams — no silent gap.

Every BRIEF §Capability-contract line resolves to a real shipped export or an explicit by-design
omission. **No capability is silently lost.** Any future absence surfaced by the gated presence
assertion (a rename/drop that fails `typecheck`) routes to the owning epic as a bug (audit-not-patch).
</content>
</invoke>
