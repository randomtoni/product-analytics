# analytics-kit

An **app-agnostic, vendor-neutral analytics abstraction library** for TypeScript. Your app codes
against one small set of neutral interfaces; the analytics backend sits behind a swappable adapter,
selected by configuration. **No vendor name appears in the library's surface.**

## Why

Most apps wire analytics calls to a specific vendor's SDK, scattered across the codebase. Swapping
vendors, or adopting the same conventions in a new app, then means touching everything.
`analytics-kit` puts a neutral seam in between:

- **Provider-swap = one adapter, zero consumer change.** Change the backend by writing one
  adapter — no consumer code changes.
- **New-app adoption = config only, zero library change.** A new app adopts by configuration
  alone.
- **Primitives, not products.** Capture an event, identify a user, run a funnel/retention query —
  not opinionated product features baked in.
- **Privacy by allowlist.** You supply the allowlist of properties permitted to leave your app;
  the library enforces it.
- **Vendor-neutral to the core.** The library's own code and public API carry no vendor
  references; the backend is configuration, not a branded dependency.

## Two layers

| Layer | Owns |
|---|---|
| **Library** (this repo) | the vendor-neutral interfaces, the enforcement (payload allowlist, batching seam), and the backend adapters |
| **Consumer app** | configuration (which backend, which properties are allowed) + calling the primitives |

The library is split `core → browser → node` (with optional React bindings) so the browser and
server stories stay honest.

## Status

Early / greenfield. The public API is not yet stable. The first supported backend is configured by
an ingest host + project key; a self-hosted backend is planned.

## Install

```sh
pnpm add analytics-kit            # the seam: contracts, taxonomy, allowlist, factory
pnpm add @analytics-kit/browser   # browser target
pnpm add @analytics-kit/node      # server-side target + query client
```

## Usage (sketch)

```ts
import { createAnalytics } from "@analytics-kit/browser";

const analytics = createAnalytics({
  // the backend is configuration — no vendor name in the API
  key: process.env.ANALYTICS_KEY!,
  ingestHost: process.env.ANALYTICS_INGEST_HOST, // point at any compatible backend
  // only these properties may leave the app:
  allowlist: ["plan", "route", "experiment_variant"],
});

// `track` is the browser/root capture verb (`capture` is the server/adapter verb):
analytics.track("checkout_completed", { plan: "pro", total_cents: 4200 });
analytics.identify("user_123", { plan: "pro" });
```

> Illustrative — see the **Interface → implementation matrix** below for the real, shipped
> surface (every method) and its config levers (`AnalyticsConfig`). See `CLAUDE.md` for the
> architecture.

## Interface → implementation matrix

This is the seam, method by method. Each row maps **one neutral interface method → the shipped
implementation that backs it today (described by role and wire shape, never by vendor) → what a
future warehouse/SQL or self-hosted implementation must satisfy** to fill that cell. A prospective
adapter author reads the third column as the exact contract to implement; a reader confirms the
seam is complete and genuinely swappable.

The shipped client and node implementations are backed by an HTTP ingest adapter ported from an
open-source reference client and **de-branded** — the vendor's name, cookie prefixes, and region
hostnames are stripped, and the ingest target is configuration (`ingestHost` / `ingestPath`), not a
baked-in endpoint. The client rows' fill-in-the-blanks contract is the `AnalyticsAdapter` SPI
(`packages/analytics-kit/src/adapter.ts`): a self-hosted backend implements that one interface and
every client verb below routes to it unchanged. The query rows' contract is the
`AnalyticsQueryClient` interface, with the `WarehouseQueryAdapter` typed stub
(`packages/node/src/query/warehouse-query-adapter.ts`) as the concrete second-adapter proof that a
SQL/warehouse fill-in is real, not hypothetical.

### Client — `AnalyticsProvider` (the 15-member frozen surface)

Thirteen methods plus the two typed extension-point ports (`flags?` / `replay?`) — exactly the
15 members of `keyof AnalyticsProvider`. The browser/root capture verb is **`track`** (the
server/adapter-level verb is `capture`). Every verb first passes the consumer allowlist, then
delegates to the backing adapter's corresponding SPI method.

| Method | Shipped implementation (by role + wire shape) | Future warehouse/SQL or self-hosted fill-in |
|---|---|---|
| `track(event, props)` | Allowlist-gated, then minted into a neutral event and handed to the adapter's `capture`; the HTTP adapter enriches and batch-buffers it for a gzipped batch POST to the configured ingest host/path. | Implement `AnalyticsAdapter.capture(event)`: accept the neutral event and durably record/forward it to your backend's ingest. |
| `identify(id, traits?, traitsOnce?)` | Gated, then routed to the adapter's `identify`; the HTTP adapter binds the distinct id and emits a set / set-once trait update on the batch wire. | Implement `AnalyticsAdapter.identify(distinctId, traits?, traitsOnce?)`: associate the id and persist the set / set-once trait bags. |
| `page(name?, props?)` | Gated, then minted as a page-view-flagged neutral event through the adapter's `capture`; the HTTP adapter emits the wire pageview event with page-context enrichment. | Implement `AnalyticsAdapter.capture(event)` and honor the event's page-view flag (record it as a page/screen view for your backend). |
| `group(type, key, props?)` | Gated, then routed to the adapter's `group`; the HTTP adapter attaches the group type/key association and its trait bag to the batch wire. | Implement `AnalyticsAdapter.group(type, key, traits?)`: record the entity-group membership and its traits. |
| `reset(options?)` | Routed to the live adapter's `reset` (never the consent-swapped one, so logout always clears identity); the HTTP adapter re-anonymizes — new anonymous distinct id, cleared identity/persistence/session, device id kept unless `resetDevice`. | Implement `AnalyticsAdapter.reset(options?)`: regenerate the anonymous id and clear identity/persistence/session state (respect `resetDevice`). |
| `setTraits(traits, once?)` | Gated, then routed to the adapter's `identify` against the current distinct id — `once` sends the trait bag as set-once, otherwise as set. | Implement `AnalyticsAdapter.identify(...)` and `getDistinctId()`: apply the set / set-once trait bag to the current identity. |
| `register(props, options?)` | Gated at registration (the one consumer-supplied source that flows into every event), then stored via the adapter's `register`; the HTTP adapter merges these super-properties onto every subsequent captured event. | Implement `AnalyticsAdapter.register(props, options?)`: persist the super-property bag (respect `once`) and merge it into all downstream captures. |
| `unregister(key)` | Gated consistently with `register`, then removed via the adapter's `unregister`; the HTTP adapter drops the single super-property so it stops riding future events. | Implement `AnalyticsAdapter.unregister(key)`: remove the single stored super-property. |
| `optIn()` | Sets the live adapter's consent state to granted and re-activates it as the active delegate; capture resumes and persistence is re-enabled. | Implement `AnalyticsAdapter.setConsentState('granted')`: enable capture and persistence. |
| `optOut()` | Sets the live adapter's consent state to denied, drops any unsent buffer, and swaps the active delegate to an inert no-op as defense-in-depth. | Implement `AnalyticsAdapter.setConsentState('denied')`: quiesce capture and suppress persistence. |
| `hasOptedOut()` | Synchronous read of the resolved opt-out state (consent state resolved against the configured consent default — unset is opt-out-by-default). | Implement `AnalyticsAdapter.getConsentState()`: report the current consent posture (the seam resolves it to a boolean). |
| `flush()` | Delegates to the live adapter's `flush`; the HTTP adapter force-sends the buffered batch immediately and resolves once the in-flight POST settles, staying usable afterward. | Implement `AnalyticsAdapter.flush(): Promise<void>`: force-send any buffered work and resolve when it settles. |
| `shutdown()` | Delegates to the live adapter's `shutdown`; the HTTP adapter drains the buffer and quiesces for process/page exit. | Implement `AnalyticsAdapter.shutdown(): Promise<void>`: drain and quiesce for exit. |
| `flags?` (extension-point port) | **Declared-only this release** — the `FeatureFlagPort` seam exists on the surface (`packages/analytics-kit/src/ports.ts`) but no implementation ships (per `planning/BRIEF.md` §"Explicitly OUT this release"). The row states the seam exists; no adapter fills it yet. | An adapter fills this by implementing `FeatureFlagPort` and attaching it as `flags` — the seam is reserved so a future backend adds flags with zero surface change. |
| `replay?` (extension-point port) | **Declared-only this release** — the `SessionReplayPort` seam exists on the surface (`packages/analytics-kit/src/ports.ts`) but no implementation ships (per `planning/BRIEF.md` §"Explicitly OUT this release"). The row states the seam exists; no adapter fills it yet. | An adapter fills this by implementing `SessionReplayPort` and attaching it as `replay` — the seam is reserved so a future backend adds replay with zero surface change. |

### Node — `NodeAnalytics` (server-side capture)

Server-side capture with no browser persistence. The verb here is **`capture`** (the server-side
name for the client's `track`). Each verb is allowlist-gated, then buffered on a batch queue whose
delivery seam is injected.

| Method | Shipped implementation (by role + wire shape) | Future warehouse/SQL or self-hosted fill-in |
|---|---|---|
| `capture(distinctId, event, props?, options?)` | Allowlist-gated, then minted (with a `dedupeId`) and enqueued on the batch queue; the injected delivery closure sends the batch as a gzipped POST to the configured ingest host/path. | Provide a delivery closure (the injected `SendBatch`): accept a batch of neutral events and forward them to your backend's ingest endpoint. |
| `setTraits(distinctId, traits, once?)` | Gated, then minted as an adapter-internal trait event carrying the set / set-once trait bag under de-branded nested wire keys, riding the same batch queue as `capture`. | Same delivery closure receives the trait event; a self-hosted backend applies its set / set-once trait bag to the distinct id. |
| `setGroupTraits(groupType, groupKey, traits)` | Gated, then minted as an adapter-internal group event (distinct id defaults to a `${groupType}_${groupKey}` composite) carrying the group type/key and trait bag under de-branded nested wire keys, on the same batch queue. | Same delivery closure receives the group event; a self-hosted backend records the group membership and applies its trait bag. |

### Query — `AnalyticsQueryClient` (KPI primitives)

Read-side KPI primitives. The shipped adapter issues the query over an HTTP query endpoint
authenticated with a Bearer personal key and normalizes the wire envelope into the neutral
`QueryResult`. The `WarehouseQueryAdapter` typed stub is the second-adapter proof; its intended
per-method SQL mapping (emitting portable SQL over a taxonomy-generated typed view) is the
fill-in-the-blanks contract below.

| Method | Shipped implementation (by role + wire shape) | Future warehouse/SQL or self-hosted fill-in |
|---|---|---|
| `funnel(spec)` | HTTP query endpoint (Bearer personal key): sends the ordered-step funnel spec, normalizes the response into `QueryResult`. | `SELECT` ordered step-completion counts from the typed view, restricted to `spec.steps` in order, keeping only distinct ids whose step timestamps fall inside `spec.within`; `GROUP BY spec.breakdown` when present; normalize rows into `QueryResult`. |
| `retention(spec)` | HTTP query endpoint (Bearer personal key): sends the cohort/return retention spec, normalizes the response into `QueryResult`. | Self-join the typed view: cohort rows (`spec.cohortEvent`) against return rows (`spec.returnEvent`) bucketed by `spec.granularity` for `spec.periods` periods; `GROUP BY spec.breakdown` when present; normalize into `QueryResult`. |
| `trend(spec)` | HTTP query endpoint (Bearer personal key): sends the time-series trend spec with its aggregation, normalizes the response into `QueryResult`. | `SELECT` a time series over `spec.window` at the derived interval, aggregated per `spec.aggregation` (count for total, distinct-id count for unique/dau); `GROUP BY spec.breakdown` when present; normalize into `QueryResult`. |
| `uniqueCount(spec)` | HTTP query endpoint (Bearer personal key): sends the unique-count spec, normalizes the response into `QueryResult`. | `SELECT count(distinct distinct_id)` over `spec.window` for the event; normalize into `QueryResult`. |
| `rawQuery(expr)` | HTTP query endpoint (Bearer personal key): passes `expr` through in the HTTP adapter's query dialect, normalizes the response into `QueryResult`. | Pass `expr` to the SQL engine as SQL (this adapter's dialect is SQL); normalize the driver's rows/columns into `QueryResult`. |

## Development

Quality gates (see `CLAUDE.md`): **typecheck · lint · test · build**, all green. Package manager:
`pnpm`; tests: `vitest`. A vendor/product-name **neutrality scan** (`pnpm neutrality-scan`) gates
the library surface **and this README** — every implementation cell above is described by role and
wire shape precisely because the scan fails on any vendor name in shipped docs.
