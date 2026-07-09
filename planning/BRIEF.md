# Build brief — analytics-kit

The canonical scope for release 1. PM/refiner agents plan against THIS document, not against
PostHog's full feature set. Corrections from the user are already folded in; where this brief and
an older doc disagree, this brief wins.

## Objective

A standalone, reusable analytics library — a vendor-neutral abstraction any app can consume. Not
tied to any product. The first backend target is PostHog-compatible. Must be capability-complete
for the first consumer's needs while staying fully app-agnostic, so that:

- **(A) Provider-swap = one new adapter, zero consumer-code change.**
- **(B) New-app adoption = config only, zero library change.** No product name, event name, or
  domain appears anywhere in the library source.

Both bars must hold — they are the acceptance test of every design.

## Release-1 posture (load-bearing)

- **Copy, don't wrap.** The library never imports a vendor SDK. Port the code we need from the
  local `posthog-js/` reference checkout (read at its current HEAD), **de-branded**: PostHog naming
  stripped, vendor endpoints/keys become configuration. Transport, identity, persistence,
  enrichment are OURS — ported minimally, not rebuilt from scratch and not gold-plated.
- **Only what we need.** The capability contract below is the whole scope. Everything included is
  built agnostically; everything else waits.
- **Zero vendor references** in the library's own code, public API, type names, package names,
  file names, and docs. Adapters are internal modules named by role, never by vendor.
- **No-op when unkeyed.** The config-selected factory yields a silent no-op provider when no key
  is configured.

## Packages

pnpm workspace + turbo; build tsup; test vitest; typecheck tsc --noEmit; lint eslint.

```
packages/
├── analytics-kit/   # main entry & the vendor-neutral seam: provider contract, adapter interface,
│                    #   typed-taxonomy mechanism, allowlist hook, config-selected factory, shared types
├── browser/         # @analytics-kit/browser — identity/persistence, transport, capture + enrichment
├── node/            # @analytics-kit/node — server-side capture + the query client
└── react/           # @analytics-kit/react — optional React/Next binding (provider + hooks)
```

No published package literally named `core` ("core" survives only as the area slug).

## Two layers — keep strictly separate

1. **The library** (the packages above): knows only analytics PRIMITIVES — events, a distinct id,
   traits, groups, sessions, queries. Knows nothing about any product's domain.
2. **The consumer config**: supplies ALL product specifics — the concrete event taxonomy, cookie
   domain, per-context config, allowlist contents, KPI/snapshot definitions, framework wiring.
   The first real consumer integrates **in its own repo**; this repo ships only a generic example
   consumer (an invented product) proving bar B.

## Agnostic design rules

- No hardcoded event names, property names, domains, product concepts, or framework assumptions.
  Everything is injected via config or generics.
- Mechanisms from the library, contents from the consumer:
  - **Typed taxonomy**: `defineTaxonomy<T>()` / a generic type param — the consumer declares its
    own events + props and gets full type-safety; the lib ships zero event names.
  - **Payload allowlist**: a validation hook on every outgoing event — only consumer-supplied keys
    are permitted; nothing off-list leaves; a violation fails loudly. Privacy POLICY is the
    consumer's; ENFORCEMENT is the library's.
- Identity is generic: distinct id + traits + groups. No notion of actor roles — a consumer maps
  its own model onto `identify()` / `group()` / event props.
- Config-injected, never assumed: ingest host, cookie domain + scope (cross-subdomain sharing),
  persistence mode, per-context capture profiles, consent defaults, adapter selection.
- Framework-agnostic seam; React/Next is an optional binding, not the core.

## Capability contract (generic primitives)

### 1. Client capture interface (`AnalyticsProvider`)
- `track(event, props)` — named events (consumer supplies the taxonomy)
- `identify(id, traits, traitsOnce)` — bind anonymous actor to a stable id; `traits` mutable,
  `traitsOnce` immutable first-touch
- `page(name?, props?)` — manual pageview (framework-router safe)
- `group(type, key, props)` — group analytics / cohorts
- `reset()` — clear identity + regenerate anonymous id (consumer calls on logout)
- `setTraits(traits, once?)` — set / set-once traits outside identify
- `optIn()` / `optOut()` / `hasOptedOut()` — consent hooks
- `flush()` / `shutdown()` — force-send buffered events

### 2. Anonymous identity + persistence (implicit — must not be forgotten)
- Generate + persist an anonymous id pre-identify.
- Cross-subdomain persistence via a config-supplied cookie domain/scope (multi-host funnel
  stitching pre-login). Consumer supplies the domain; the lib never hardcodes one.
- Configurable persistence mode: cookie (default) vs memory (consent-declined / no-op state).
- `identify()` performs the anonymous→identified merge, client-side only.
- Session id assignment + expiry (events group into sessions; independent of replay).

### 3. Auto-enriched context (implicit — each individually opt-out-able)
- Page context: current_url, pathname, host, referrer, referring_domain.
- UTM auto-parse from URL (source/medium/campaign/term/content).
- Device/browser context: browser, os, device_type, screen + viewport, lib + version.
- Per-event timestamp + a dedupe id (idempotent retries).
- pageleave capture (time-on-page / bounce), toggleable.
- Country enrichment: pluggable — consumer may inject a country source (e.g. an edge header)
  and/or disable GeoIP (privacy).

### 4. Transport / reliability (implicit)
- Batching + compression; retry with backoff; offline queue (survives reloads).
- sendBeacon / keepalive on unload so last/leave events aren't dropped.
- First-party reverse-proxy ingestion via a config-supplied ingest host/path.
- Bot/crawler filtering.
- Per-context capture profiles: the consumer defines named contexts (e.g. "marketing" vs "app")
  and a capture profile per context (autocapture on/off, manual vs auto pageview); the lib applies
  the profile, the consumer names the contexts.

### 5. Autocapture (opt-in per context)
- Auto-capture clicks / input-changes / form-submits → element metadata. Toggleable per context;
  default off. Port minimally.

### 6. Server-side capture interface (node)
- `capture(id, event, props)` — server-truth events keyed on the same distinct id.
- `setTraits` / `setGroupTraits` — server-side property updates.
- No-op without key; idempotent (dedupe on the event's insert id).
- (A non-JS backend can call the vendor's HTTP endpoints directly; the node package is the TS
  realization, not a constraint on consumers.)

### 7. Query interface (`AnalyticsQueryClient`) — for durable KPI snapshotting
- `funnel({steps, within, breakdown?})`
- `retention({cohortEvent, returnEvent, periods, granularity, breakdown?})`
- `trend({event, aggregation, breakdown?, window})`
- `uniqueCount({event, window, breakdown?})`
- `rawQuery(expr)` — adapter-specific escape hatch
- First adapter speaks the PostHog Query API (HogQL over HTTP; server personal key, config-supplied
  endpoint). A future adapter is SQL over a consumer-owned warehouse (stub the interface). The
  consumer owns snapshot STORAGE + KPI definitions; the lib owns the query PRIMITIVES.

## Adapters this release
- Client: the ported/de-branded HTTP ingestion adapter (PostHog-compatible wire format, endpoint
  via config) + null/no-op adapter.
- Server: ported server capture adapter + no-op; HTTP query adapter + warehouse stub.
- More adapters (self-hosted, another vendor) are additive — one new adapter, nothing else.

## Explicitly OUT this release (typed extension points only — do not implement)
- Session replay · feature flags / experiments · surveys · heatmaps.

## Deliverables
1. The packages above.
2. A **generic example consumer** (invented product) under `examples/`: concrete taxonomy, identity
   mapping, cookie domain, named contexts + capture profiles, allowlist contents, KPI/snapshot
   definitions, framework wiring — zero product logic in the lib. (The first real consumer
   integrates in its own repo.)
3. Tests: headless no-op (no key); anonymous→identified merge across a simulated cross-subdomain
   journey; `reset()` clears identity; per-context capture profile applied; the allowlist hook
   rejects a disallowed key loudly; each query method returns the shape a snapshot job expects.
4. README: each interface method → its ported implementation → the intended future warehouse/SQL
   implementation (a new adapter is fill-in-the-blanks); plus an "adopt in a new app" (config-only)
   section.

## Epic order (proposed — pending user approval)

| # | Epic | Areas |
|---|------|-------|
| E1 | Workspace & toolchain scaffold — all four gates green on empty packages | core |
| E2 | Core seam: `AnalyticsProvider` contract + config-selected factory + no-op adapter | core, adapters |
| E3 | Core mechanisms: typed taxonomy + allowlist enforcement | core, privacy |
| E4 | Browser identity & persistence: anon id, cookie domain/scope, memory mode, merge, sessions, reset | identify, browser |
| E5 | Browser transport: batch, compression, retry/backoff, offline queue, beacon, ingest host config, dedupe ids, bot filter | capture, adapters |
| E6 | Browser capture & enrichment: track/page/pageleave, page/UTM/device context + opt-outs, country plug, per-context profiles, autocapture opt-in | capture, browser |
| E7 | Node capture: server capture + traits, idempotency, no-op | node |
| E8 | Query client: interface + HTTP query adapter + warehouse stub | query |
| E9 | React/Next binding: provider + hooks | react |
| E10 | Generic example consumer — proves bar B | (consumer, examples/) |
| E11 | Docs + acceptance-bar audit — README matrix, adopt-in-a-new-app guide, bar A/B sweep incl. vendor/product-name scan | observability, core |

Dependencies: E2/E3 gate everything. After E3, tracks {E4→E5→E6→E9}, {E7}, {E8} can run in
parallel; E10 needs E4–E9; E11 closes.
