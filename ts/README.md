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

## Install (consumers)

Published **privately to GitHub Packages** under the `@randomtoni` scope. Point the scope at the
GitHub registry and authenticate with a GitHub token that has `read:packages`: add a project
`.npmrc`

```ini
@randomtoni:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

and export `GITHUB_PACKAGES_TOKEN` (a PAT with `read:packages`). Then install only the target(s)
you need:

```sh
npm install @randomtoni/analytics-kit            # the seam: contracts, taxonomy, allowlist, factory
npm install @randomtoni/analytics-kit-browser    # browser target (createAnalytics + track)
npm install @randomtoni/analytics-kit-node       # server-side target + query client
npm install @randomtoni/analytics-kit-react      # optional React binding (provider + hooks)
```

A browser + React app typically installs both targets in one line (the seam arrives as a transitive
dependency, so it need not be listed unless you import its types/taxonomy helpers directly):

```sh
npm install @randomtoni/analytics-kit-browser @randomtoni/analytics-kit-react
```

All four ship at the same version with dual ESM + CJS builds and bundled types. (`pnpm`/`yarn` work
identically — swap `npm install` for `pnpm add` / `yarn add`.)

## Usage (sketch)

```ts
import { createAnalytics } from "@randomtoni/analytics-kit-browser";

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
implementation that backs it today (described by role and wire shape, never by vendor) → the SPI
method an alternative backend satisfies** to fill that cell. A prospective
adapter author reads the third column as the exact contract to implement; a reader confirms the
seam is complete and genuinely swappable.

The shipped client and node implementations are backed by an HTTP ingest adapter ported from an
open-source reference client and **de-branded** — the vendor's name, cookie prefixes, and region
hostnames are stripped, and the ingest target is configuration (`ingestHost` / `ingestPath`), not a
baked-in endpoint. The client rows' fill-in-the-blanks contract is the `AnalyticsAdapter` SPI
(`packages/analytics-kit/src/adapter.ts`): a self-hosted backend implements that one interface and
every client verb below routes to it unchanged. The query rows' contract is the
`AnalyticsQueryClient` interface, and the **shipped** `WarehouseQueryAdapter`
(`packages/node/src/query/warehouse-query-adapter.ts`) is the concrete second backend behind it —
real SQL over the taxonomy-generated typed view, factory-selected the moment a `warehouseDsn` is
configured, satisfying that interface with zero Protocol change (the zero-egress acceptance test
exercises it end to end against a real Postgres).

### Client — `AnalyticsProvider` (the 15-member frozen surface)

Thirteen methods plus the two optional ports (`flags?` / `replay?`, both now implemented — replay
on the browser/TS target) — exactly the 15 members of `keyof AnalyticsProvider`. The browser/root capture verb is **`track`** (the
server/adapter-level verb is `capture`). Every verb first passes the consumer allowlist, then
delegates to the backing adapter's corresponding SPI method.

| Method | Shipped implementation (by role + wire shape) | SPI method to satisfy (the fill-in contract) |
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
| `flags?` (feature-flag port) | **Implemented** — the `FeatureFlagPort` seam (`packages/analytics-kit/src/ports.ts`) is backed by real adapters: a browser remote-eval adapter, a node remote adapter, and node **local (in-process) eval** (poll flag definitions, evaluate cohort/rollout/hash rules against the `FlagContext`, fall back to remote for undecidable flags). Evaluation strategy is entirely adapter-internal behind the one `evaluate` method; `onlyEvaluateLocally`/poll-interval/definitions-endpoint are adapter config. | Another backend fills this by implementing `FeatureFlagPort` and attaching it as `flags`; a definition-reading backend may additionally supply the local poller/evaluator — the seam is unchanged either way. |
| `replay?` (session-replay port) | **Implemented** (browser/TS) — the `SessionReplayPort` seam (`packages/analytics-kit/src/ports.ts`) is backed by a real browser recorder (`ReplayRecorder implements SessionReplayPort` in `@randomtoni/analytics-kit-browser`): rrweb behind the adapter on a separate `@randomtoni/analytics-kit-browser/replay` entrypoint so a non-replay consumer never bundles it, enabled config-only via `sessionReplay` (sampling + privacy masking) and session-linked to captured events via `getReplayId`, with its own snapshot delivery path. Browser-shaped: there is no server analog (a server has no DOM to record). | Another backend fills this by implementing `SessionReplayPort` and attaching it as `replay` — the seam is unchanged whether an adapter fills it or leaves `replay` unset. |

### Node — `NodeAnalytics` (server-side capture)

Server-side capture with no browser persistence. The verb here is **`capture`** (the server-side
name for the client's `track`). Each verb is allowlist-gated, then buffered on a batch queue whose
delivery seam is injected.

| Method | Shipped implementation (by role + wire shape) | SPI method to satisfy (the fill-in contract) |
|---|---|---|
| `capture(distinctId, event, props?, options?)` | Allowlist-gated, then minted (with a `dedupeId`) and enqueued on the batch queue; the injected delivery closure sends the batch as a gzipped POST to the configured ingest host/path. | Provide a delivery closure (the injected `SendBatch`): accept a batch of neutral events and forward them to your backend's ingest endpoint. |
| `setTraits(distinctId, traits, once?)` | Gated, then minted as an adapter-internal trait event carrying the set / set-once trait bag under de-branded nested wire keys, riding the same batch queue as `capture`. | Same delivery closure receives the trait event; a self-hosted backend applies its set / set-once trait bag to the distinct id. |
| `setGroupTraits(groupType, groupKey, traits)` | Gated, then minted as an adapter-internal group event (distinct id defaults to a `${groupType}_${groupKey}` composite) carrying the group type/key and trait bag under de-branded nested wire keys, on the same batch queue. | Same delivery closure receives the group event; a self-hosted backend records the group membership and applies its trait bag. |
| `flush()` | Force-drains the in-memory batch queue immediately (bypassing the size/interval trigger) via the injected delivery closure and resolves once the in-flight send(s) settle; the client stays usable afterward. | Same delivery closure receives the force-sent batch; resolve when your forward settles. Shares the client's lifecycle semantics. |
| `shutdown()` | Drains the queue and quiesces for process exit — marks the client stopped first so racing captures go inert, re-drains until empty (raced against a timeout so a wedged backend can't hang the process), then clears the queue timers. | Same delivery closure receives the final drained batches; the seam quiesces after. Shares the client's lifecycle semantics. |

### Query — `AnalyticsQueryClient` (KPI primitives)

Read-side KPI primitives. The shipped adapter issues the query over an HTTP query endpoint
authenticated with a Bearer personal key and normalizes the wire envelope into the neutral
`QueryResult`. The four structured primitives (`funnel`/`retention`/`trend`/`uniqueCount`) return
**documented per-primitive neutral rows** — the adapter flattens the backend's insight shapes into a
narrowed `QueryResult<TRow>` whose row fields are the contract consumers key on (no engine-internal
keys leak); `rawQuery` alone keeps the default `Record<string, unknown>` verbatim column-keyed row.
The per-primitive wire→neutral-row contract fixtures live at
[`packages/node/src/query/query-contract.fixtures.ts`](packages/node/src/query/query-contract.fixtures.ts)
(the executable form of the contract). The **shipped** `WarehouseQueryAdapter` is the second backend
behind this seam — it emits real SQL over the taxonomy-generated typed view for each primitive below,
factory-selected by `warehouseDsn` presence, with zero Protocol change.

| Method | Shipped implementation (by role + wire shape) | SPI method to satisfy (the fill-in contract) |
|---|---|---|
| `funnel(spec)` | HTTP query endpoint (Bearer personal key): sends the ordered-step funnel spec, normalizes the response into `QueryResult<{ step, event, count, conversionRate, breakdown? }>` (one row per funnel step; `conversionRate` is computed relative to the first step, per-group when broken down). | `SELECT` ordered step-completion counts from the typed view, restricted to `spec.steps` in order, keeping only distinct ids whose step timestamps fall inside `spec.within`; `GROUP BY spec.breakdown` when present; normalize rows into `QueryResult`. |
| `retention(spec)` | HTTP query endpoint (Bearer personal key): sends the cohort/return retention spec, normalizes the response into `QueryResult<{ cohort, periodIndex, value, breakdown? }>` (one row per cohort×period cell; `periodIndex` 0 is the cohort's own period). | Self-join the typed view: cohort rows (`spec.cohortEvent`) against return rows (`spec.returnEvent`) bucketed by `spec.granularity` for `spec.periods` periods; `GROUP BY spec.breakdown` when present; normalize into `QueryResult`. |
| `trend(spec)` | HTTP query endpoint (Bearer personal key): sends the time-series trend spec with its aggregation, normalizes the response into `QueryResult<{ bucket, value, breakdown? }>` (one row per time bucket; one row-series per `breakdown` when present). | `SELECT` a time series over `spec.window` at the derived interval, aggregated per `spec.aggregation` (count for total, distinct-id count for unique/dau); `GROUP BY spec.breakdown` when present; normalize into `QueryResult`. |
| `uniqueCount(spec)` | HTTP query endpoint (Bearer personal key): sends the unique-count spec, normalizes the response into `QueryResult<{ bucket, value, breakdown? }>` (same neutral row shape as `trend` — a trend with distinct-id math). | `SELECT count(distinct distinct_id)` over `spec.window` for the event; normalize into `QueryResult`. |
| `rawQuery(expr)` | HTTP query endpoint (Bearer personal key): passes `expr` through in the HTTP adapter's query dialect, normalizes the response into the default `QueryResult<Record<string, unknown>>` — verbatim column-keyed pass-through, the row keys are `expr`'s own SELECT projection (the one place a dialect-keyed shape legitimately surfaces). | Pass `expr` to the SQL engine as SQL (this adapter's dialect is SQL); normalize the driver's rows/columns into `QueryResult`. |

## Adopt in a new app

The second acceptance bar — **new-app adoption = config only, zero library change** — means a new
app becomes a full consumer by supplying **configuration and generics alone**, editing nothing under
`packages/**`. This section walks that path one lever at a time. The theme throughout is
**mechanisms from the library, contents from the consumer**: the library owns each mechanism
(typing, enforcement, persistence, batching, delivery, query normalization); the consumer supplies
the contents (its own event/trait names, its actor model, its permitted keys, its KPI definitions)
through config and type parameters.

Every lever below is a real shipped export. Install only the target you need — see
[Install (consumers)](#install-consumers) above for the four package names.

### 1. Typed taxonomy — declare your own events, traits, groups, page props

**Consumer supplies:** its own event/trait/group/page-property vocabulary as a declaration passed to
`defineTaxonomy`. **Library owns:** the typing mechanism — `defineTaxonomy` returns a `Taxonomy`
whose `ShapeOf<T>` is threaded as the `TX` generic through every surface (client, node, query), so a
misnamed event or a wrong-typed property is a compile error, not a runtime surprise.

```ts
import { defineTaxonomy, type ShapeOf } from "@randomtoni/analytics-kit";

const taxonomy = defineTaxonomy({
  events: { checkout_completed: { plan: "string", total_cents: "number" } },
  traits: { plan: "string" },
  groups: { workspace: { seats: "number" } },
  page: { route: "string" },
});
// createAnalytics({ taxonomy, ... }) infers the whole typed surface from this one declaration.
```

The taxonomy is declared **once** and carried across the client, the node capture surface, and the
query client via the same `ShapeOf<T>` generic — one vocabulary, every surface.

### 2. Identity mapping — map your actor model onto the neutral verbs

**Consumer supplies:** the mapping from its own domain model (users, accounts, workspaces) onto the
neutral identity verbs — `identify(id, traits?, traitsOnce?)`, `group(type, key, props?)`, and event
properties. **Library owns:** identity persistence and association; it carries **no** built-in roles
or account concepts, so nothing about your domain leaks into the seam. You decide what a distinct id
is and which of your entities become groups.

```ts
analytics.identify(user.id, { plan: user.plan });
analytics.group("workspace", workspace.id, { seats: workspace.seatCount });
```

### 3. Cookie domain + scope, persistence mode

**Consumer supplies:** three `AnalyticsConfig` fields — `cookieDomain` (which domain the identity
cookie is scoped to), `crossSubdomainCookie` (whether identity is shared across subdomains, so a
visitor recognized on the marketing subdomain stays the same person in the app), and `persistence`
(`'cookie' | 'localStorage+cookie' | 'memory'`). **Library owns:** the persistence mechanism itself —
where and how identity/session state is stored and read back.

```ts
createAnalytics({
  taxonomy,
  cookieDomain: ".example.com",
  crossSubdomainCookie: true,
  persistence: "localStorage+cookie",
});
```

### 4. Named contexts + capture profiles

**Consumer supplies:** a `contexts` map of named `CaptureProfile`s (each a partial bundle of the
existing `autocapture` / `enrichment` toggles) plus an optional `defaultContext`. **Library owns:**
the scoping mechanism — `analytics.context(name)` returns a `ScopedAnalytics` view that applies the
named profile's per-event enrichment while sharing one identity, session, and transport with the
root, so cross-context funnels still stitch together.

```ts
const analytics = createAnalytics({
  taxonomy,
  enrichment: { page: true, device: true },
  contexts: { embed: { enrichment: { device: false } } },
  defaultContext: "embed",
});

analytics.context("embed").track("checkout_completed", { plan: "pro", total_cents: 4200 });
```

### 5. The payload allowlist

**Consumer supplies:** the set of property keys permitted to leave the app — as an explicit
`allowlist` array, plus an `onViolation` policy (`'throw' | 'drop-and-error-log'`). You can derive
the allowlist from your taxonomy with `deriveAllowlistFromTaxonomy(taxonomy)` so the permitted keys
stay in lockstep with your declared events, traits, and groups (page props are not derived — declare
those in the allowlist explicitly, or they're blocked at the seam). **Library owns:** enforcement — `enforceAllowlist`
gates every capture, identify, group, and register call before anything reaches the backend, so an
off-list property is stopped at the seam.

```ts
import { deriveAllowlistFromTaxonomy } from "@randomtoni/analytics-kit";

createAnalytics({
  taxonomy,
  allowlist: deriveAllowlistFromTaxonomy(taxonomy), // or an explicit string[]
  onViolation: "drop-and-error-log",
});
```

### 6. KPI / snapshot definitions — the query client

**Consumer supplies:** its KPI definitions as calls to the query client — `funnel`, `retention`,
`trend`, `uniqueCount`, and the escape-hatch `rawQuery` — plus where snapshots of the results get
stored (the consumer owns snapshot storage; the library computes, it does not persist reports).
**Library owns:** the read-side mechanism — `createQueryClient` (from `@randomtoni/analytics-kit-node`) issues
each primitive against the configured read endpoint and normalizes the response into a neutral
`QueryResult`. The same taxonomy generic types the step/event names in each spec.

```ts
import { createQueryClient } from "@randomtoni/analytics-kit-node";

const queries = createQueryClient({
  taxonomy,
  queryEndpoint: process.env.ANALYTICS_QUERY_ENDPOINT,
  personalKey: process.env.ANALYTICS_PERSONAL_KEY,
  projectId: process.env.ANALYTICS_PROJECT_ID,
});

const result = await queries.funnel({
  steps: ["checkout_completed"],
  within: { value: 7, unit: "day" },
});
```

### 7. Framework wiring — the optional React binding

**Consumer supplies:** the client instance it built with `createAnalytics`, handed to
`AnalyticsClientProvider` at the app root, plus its own route key for page tracking. **Library
owns:** the wiring — `useAnalytics()` reads the typed client from context, and `usePageView(routeKey)`
fires a page view on route change. Nothing framework-specific leaks into the core seam; the binding
is an optional install (`@randomtoni/analytics-kit-react`).

```tsx
import { AnalyticsClientProvider, useAnalytics, usePageView } from "@randomtoni/analytics-kit-react";

function App({ analytics, route }) {
  return (
    <AnalyticsClientProvider client={analytics}>
      <Page route={route} />
    </AnalyticsClientProvider>
  );
}

function Page({ route }) {
  usePageView(route, { name: route });
  const analytics = useAnalytics();
  return <button onClick={() => analytics.track("checkout_completed", { plan: "pro", total_cents: 4200 })}>Buy</button>;
}
```

### The bar-B invariant

Every lever above is **configuration or a type parameter** — none of it edits the library. A new app
adopts `analytics-kit` with **zero edits under `packages/**`**: it declares a taxonomy, supplies an
allowlist, sets its cookie/persistence/context config, defines its KPIs, and wires the optional React
binding — all from its own code. The runnable proof of this exact path is the consumer under
`examples/fernly`: a workspace member that adopts the library by config alone, typechecks its whole
usage against the shipped surface, and touches nothing under `packages/**`. Read it as the worked,
end-to-end reference for everything in this section.

## Bar A: provider-swap = one adapter, zero consumer change

The second acceptance bar is: **swapping the backend means writing ONE adapter and changing NO
consumer code.** This section is the audit — the finite SPI a new backend fills, a concrete
re-runnable swap that proves zero consumer change, and the shipped precedent that a second adapter
already drops in behind the seam unchanged.

### The client SPI a new adapter fills

A new client backend is a single class satisfying the `AnalyticsAdapter` interface
(`packages/analytics-kit/src/adapter.ts`). It is a **bounded, finite surface** — implement these
**18 members**, and nothing else in the library changes:

| # | Member | Role |
|---|--------|------|
| 1 | `capture(event)` | Enqueue a neutral event for delivery. |
| 2 | `identify(distinctId, traits?, traitsOnce?)` | Bind the actor and set/first-set traits. |
| 3 | `register(props, options?)` | Store super-properties merged into every event; `once` keeps the first value. |
| 4 | `unregister(key)` | Remove one super-property key. |
| 5 | `reset(options?)` | Re-anonymize on logout; keep the device id unless re-minted. |
| 6 | `getDistinctId()` | Cheap synchronous read of the current distinct id. |
| 7 | `group(type, key, traits?)` | Associate the actor with a group and set its traits. |
| 8 | `alias(previousId, distinctId)` | Link two ids as the same actor. |
| 9 | `flush()` | Drain any queued events; resolves when quiesced. |
| 10 | `shutdown()` | Flush and release resources. |
| 11 | `getConsentState()` | Read the current consent posture. |
| 12 | `setConsentState(state)` | Set the consent posture. |
| 13 | `fetch(url, options)` | The transport primitive — neutral request/response shape. |
| 14 | `getPersistedProperty(key)` | Read one persisted value. |
| 15 | `setPersistedProperty(key, value)` | Write/clear one persisted value. |
| 16 | `getLibraryId()` | Identify the emitting library on the wire. |
| 17 | `getLibraryVersion()` | The library version on the wire. |
| 18 | `getCustomUserAgent()` | Optional user-agent override for outbound requests. |

The consumer facade (`AnalyticsProvider` / `RootAnalytics`), the configuration surface
(`AnalyticsConfig`), the typed taxonomy, the allowlist, and every line of consumer code stay
**untouched**. A new backend is genuinely fill-in-the-blanks: satisfy the 18 members, pass the
same object into `createAnalytics(config, adapter, deps)`, done. (An on-paper second adapter — say a
self-hosted client — is exactly this: one class implementing the 18 members, translating each neutral
primitive to its own wire, and nothing outside the class moves.)

### The swap, demonstrated re-runnably

The concrete proof is a re-runnable check: the **same consumer call site** works across two adapters
with zero consumer edits. The consumer under `examples/fernly` selects its backend by config through
one seam — an unkeyed setup gets the no-op adapter, a keyed setup gets a recording adapter — and both
flow through the identical `createAnalytics(config, adapter, deps)` call. The swap audit asserts that:

- both adapters satisfy the 18-member `AnalyticsAdapter` SPI (structurally);
- the same call site produces the same `RootAnalytics` facade — its `keyof` is **identical** across
  the swap;
- the same sequence of neutral facade calls (`identify` / `track` / `group` / `register` / `page` /
  `reset`) runs identically against either backend; the only difference lives **behind the seam**
  (the no-op backend records nothing, the recording backend captures the same driven stream).

Consumer code is byte-identical across the swap — only which adapter the seam selected differs.

## Self-host recipe: run the loop on your own Neon

The library ships **two selectable backends behind the same seam**, and neither is privileged in the
code:

- **the default HTTP backend** — an ingest host + project key write the batch wire and a query
  endpoint serves the reads (the `ingestHost` / `queryEndpoint` config above);
- **the self-host warehouse backend** — capture → store → query runs entirely against **your own
  Neon Postgres**, with **zero HTTP calls to any hosted analytics service**.

This section is the provider-swap walkthrough for the self-host backend: the full stand-up, the
config levers, and — stated honestly — the external prerequisites. It is **provisioning and
configuration, not config-only magic**: you provision a database, run a migration, install a driver,
author your flag definitions, and mount a handler. None of it edits the library; all of it is
your own code and config.

### What you provision (the honest prerequisites)

The self-host loop has real external prerequisites. Named plainly:

1. **A Neon Postgres database and its DSN.** You create the database; the library never provisions
   infrastructure.
2. **The migration, run once against that database.** The library generates the DDL; you execute it.
3. **The optional warehouse driver, installed.** The Postgres driver ships as an **optional peer
   dependency** so importing the node package without a warehouse never requires it — the self-host
   path needs it present.
4. **Your static flag definitions, authored.** The zero-infra flag posture evaluates in-process from
   definitions you write; you supply them.
5. **A mounted receiver handler.** The write endpoint is a handler you mount on your own server.

**Postgres ≥16 is required.** The generated typed view uses `pg_input_is_valid`, a Postgres-16
function, for its safe casts — a Postgres-15 database gets a view that **errors at creation**. Neon
runs 16/17/18, so a fresh Neon database satisfies the floor. State this to your operator before you
provision.

### 1. Run the migration against your Neon

`buildMigrationSql(taxonomy)` (from `@randomtoni/analytics-kit-node`) returns the idempotent
migration for **your** taxonomy: the fixed `events` table DDL followed by a generated typed view
(one safe-cast column per declared event property). It emits a SQL string and executes nothing — you
run it against your Neon DSN with whatever migration tooling you already use. Re-running is safe
(`CREATE TABLE IF NOT EXISTS` + `CREATE OR REPLACE VIEW`).

```ts
import { buildMigrationSql } from "@randomtoni/analytics-kit-node";

const sql = buildMigrationSql(taxonomy); // run this string against your Neon database once
```

The typed view is generated **from the same taxonomy** you already declared for capture — one
vocabulary, both the write shape and the queryable columns.

### 2. Install the warehouse driver

The default warehouse driver is an **optional peer dependency** — install `pg` (node-postgres)
alongside the node target. The node package imports clean without it (the driver loads lazily on
first execution), so only a self-host consumer takes the dependency:

```sh
npm install @randomtoni/analytics-kit-node pg
```

### 3. Supply `warehouseDsn` — the single self-host signal

Selection is **by field presence, not a `backend:` enum**. Supplying `warehouseDsn` is the one
signal that selects the warehouse query adapter and the DSN-backed receiver; absent it, the same
factories select the HTTP backend or a silent no-op. `createQueryClient`
(`packages/node/src/query/create-query-client.ts`) routes to the `WarehouseQueryAdapter` the moment a
`warehouseDsn` is present:

```ts
import { createQueryClient } from "@randomtoni/analytics-kit-node";

const queries = createQueryClient({
  taxonomy,
  warehouseDsn: process.env.WAREHOUSE_DSN, // presence selects the warehouse read path
});
```

The same `taxonomy`, identity mapping, allowlist, and event names you use for the default backend
carry over **unchanged** — only this one config field differs.

### 4. Author your static flag definitions (zero-infra, local-only)

The self-host flag posture evaluates flags **in-process** from definitions you author — no flag
service, no flag-definitions endpoint, no network round-trip. Supply your neutral
`FeatureFlagDefinition[]` on `staticDefinitions` and set `onlyEvaluateLocally: true`; the client polls
nothing and evaluates every flag against the `FlagContext` locally
(`packages/node/src/flags/create-flag-client.ts`):

```ts
import { createFlagClient } from "@randomtoni/analytics-kit-node";

const flags = createFlagClient({
  taxonomy,
  key: process.env.ANALYTICS_KEY!,
  staticDefinitions: myFlagDefinitions, // FeatureFlagDefinition[] you author
  onlyEvaluateLocally: true,            // in-process only; zero flag-service calls
});
```

An empty `staticDefinitions` set seeds an empty, flags-off client (a dev-time warning fires) — supply
at least one definition. A malformed set throws at client construction, not lazily at first eval.

### 5. Mount the receiver

The write endpoint is a **receiver** you mount on your own server.
`createReceiverFromConfig({ warehouseDsn })`
(`packages/node/src/receiver/create-receiver-from-config.ts`) reads the DSN, builds the default driver
from it, and returns a framework-agnostic `Receiver`. Hand that `Receiver` to the mount for your
framework — Express (`createExpressReceiver`), Next route or API
(`createNextRouteReceiver` / `createNextApiReceiver`), or a plain handler (`createReceiverHandler`):

```ts
import { createReceiverFromConfig, createExpressReceiver } from "@randomtoni/analytics-kit-node";

const receiver = createReceiverFromConfig({ warehouseDsn: process.env.WAREHOUSE_DSN });
app.post("/ingest", createExpressReceiver(receiver)); // your route, your server
```

A receiver with **no** `warehouseDsn` throws a clear neutral error at construction rather than
silently accepting and dropping events — a write with nowhere to go is a misconfiguration, not an
empty-success.

### Same app code, only the config differs (Bar A + Bar B)

The self-host config uses the **same taxonomy, identity mapping, allowlist, and event names** as the
default-backend config. **No consumer code changes** — the call sites (`track` / `identify` / `group`
/ the query primitives) are byte-identical across the swap. Only the configuration and the mounted
handler differ:

- **Bar A** (provider-swap = one adapter, zero consumer change): the warehouse adapter and the
  DSN-backed receiver are the "one adapter"; every call site stays put.
- **Bar B** (new-app adoption = config only, zero library change): a new app stands up self-host by
  **config + migration + mount** — nothing under `packages/**` is edited.

The default backend stays **one selectable backend among two** — not the default-by-privilege, not
the only one. Self-host is selected purely by supplying `warehouseDsn`.

### Query-time expectations (self-host reads)

Two behaviors are inherent to running SQL over your own Postgres — expectations to know, not
defects:

- **`text → timestamptz` casts are session-dependent for ambiguous inputs.** A timestamp string with
  an ambiguous field order is resolved against the session's `DateStyle` / `TimeZone` settings. This
  is inherent to the cast, not an error — pin those session settings if your ingested timestamps are
  ambiguous. (This is the value-parsing cast only; the bucket labels the queries emit are
  session-immune `to_char` renders.)
- **The retention breakdown groups per `(distinct_id, cohort_bucket, value)`.** An actor with two
  breakdown values in one cohort week lands in **both** breakdown cohorts — one row per distinct
  breakdown value, by design.
- **Breakdown keys must be declared event properties.** A breakdown groups on the taxonomy-declared
  typed-view column; an **undeclared breakdown key raises at query-build time**, before any SQL runs.
  Declare the property in your taxonomy (so the migration projects its column) and the breakdown works
  end to end.

### The query-side precedent (already met)

Bar A is **already met on the query side**, shipped. Two adapters sit behind ONE
`AnalyticsQueryClient` interface, both real exports from `@randomtoni/analytics-kit-node`:

- `HttpQueryAdapter` — the first backend: translates each neutral KPI primitive (`funnel`,
  `retention`, `trend`, `uniqueCount`, `rawQuery`) to an HTTP query endpoint and normalizes the wire
  envelope back into the neutral `QueryResult`.
- `WarehouseQueryAdapter` — the **shipped** second backend behind the same `AnalyticsQueryClient`
  interface: it emits real SQL over the taxonomy-generated typed view for each primitive,
  factory-selected the moment a `warehouseDsn` is configured, with zero Protocol change (proven by the
  zero-egress end-to-end acceptance test on real Postgres).

**Two adapters, one interface, seam unchanged** — the concrete precedent that a second backend drops
in behind the seam with no consumer or library-seam edits. Tie it together: the 18-member
`AnalyticsAdapter` SPI is the fill-in surface for a new client backend, the demonstrated swap proves
zero consumer change on the client side, and the query-side pair proves the exact same pattern
already holds for the query seam.

## Development

Quality gates (see `CLAUDE.md`): **typecheck · lint · test · build**, all green. Package manager:
`pnpm`; tests: `vitest`. A vendor/product-name **neutrality scan** (`pnpm neutrality-scan`) gates
the library surface **and this README** — every implementation cell above is described by role and
wire shape precisely because the scan fails on any vendor name in shipped docs.
