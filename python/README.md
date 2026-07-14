# analytics-kit — Python

The Python implementation of the vendor-neutral analytics library. Sibling to the TypeScript
implementation under [`../ts/`](../ts/); the two stay at **capability parity** — every capability the
TS surface exposes must be reachable here, adapted idiomatically (server-shaped: a plain client +
framework bindings; **no browser/DOM target**).

The seam is built: a `Protocol`-based provider contract and adapter SPI, a typed taxonomy, the
consumer-supplied allowlist, a config-selected factory, a server capture target, the query read
client, and the optional framework bindings — all reachable through the public `analytics_kit`
surface. The `flags?` slot is **implemented** — a server flag client with remote eval and local
(in-process) eval at cross-tree parity with the TS node client; the `replay?` slot is **N-A by
platform** — session replay records DOM mutations in a browser, and a server-shaped client has no
DOM to record, so the slot stays permanently `None` (a final, documented platform boundary, not a
pending gap). The sections below map every capability to the TS surface, map every verb to its
shipped implementation, and walk config-only adoption.

## Toolchain

- **uv** — env + dependencies (the `pnpm` analog)
- **pytest** — tests (the `vitest` analog)
- **ruff** — lint (the `eslint` analog)
- **mypy** — type-check, strict (the `tsc --noEmit` analog)

```
cd python
uv run pytest        # tests
uv run ruff check    # lint
uv run mypy          # type-check (strict)
```

## Layout

```
src/analytics_kit/    # the vendor-neutral seam
tests/
pyproject.toml        # packaging + tool config
```

## Capability parity with the TypeScript surface

This implementation is at **capability parity** with the TS surface, adapted idiomatically for a
server shape (a plain client, no browser/DOM target). Every capability the TS surface exposes falls
into exactly one of these dispositions here — **no silent gap**:

- **direct-analog** — same verb, same shape;
- **idiomatic-adaptation** — the same capability, re-expressed for a server (fewer verbs, a
  construction-time lever);
- **N-A by platform** — a browser-only mechanism with no server home, omitted **by design** (not a
  gap). This is a *final* disposition, not a pending one: there is no future cycle that fills an
  N-A-by-platform slot.

A fourth disposition — **declared-but-unimplemented slot** (a capability port declared on the seam
but awaiting its owning cycle) — has **no members** as of this release: `flags` graduated to
implemented (E12 remote + E13 local eval), and `replay` moved to N-A-by-platform (a browser-only
DOM recorder has no server home). Kept named here as the distinct category the PY8 audit locked, so
a future declared-only slot has a documented home to land in.

### Client facade — the fifteen reference members

The reference client facade has fifteen members. Their server disposition is the source of truth in
`provider.py`'s module docstring; the matrix below is that accounting re-expressed for a consumer.

| Reference member | Disposition | Python surface |
| --- | --- | --- |
| `track` | direct-analog | `capture(distinct_id, event, properties=None, *, dedupe_id=None)` |
| `identify` | idiomatic-adaptation | `set(distinct_id, traits, once=False)` — server person-props update, **not** an anonymous→identified merge; two reference members (`identify`, `setTraits`) collapse to this one verb |
| `setTraits` | idiomatic-adaptation | `set(...)` — the same verb as the row above |
| `group` | idiomatic-adaptation | `set_group_traits(group_type, group_key, traits)` |
| `optIn` | direct-analog | `opt_in()` |
| `optOut` | direct-analog | `opt_out()` |
| `hasOptedOut` | direct-analog | `has_opted_out()` |
| `flush` | direct-analog | `flush()` (synchronous, drain-to-completion) |
| `shutdown` | direct-analog | `shutdown()` (synchronous, drain-to-completion) |
| `page` | N-A by platform | no server pageview surface — documented, absent |
| `reset` | N-A by platform | no persisted server identity to re-anonymize |
| `register` | N-A by platform (as a runtime verb) | no runtime super-property store server-side; the **capability** is preserved idiomatically as the construction-time `super_properties` dict, merged into every capture |
| `unregister` | N-A by platform | no runtime super-property store to remove from server-side — no analog |
| `flags` | idiomatic-adaptation | **Implemented** — a server `FeatureFlagPort` client: `evaluate(FlagContext) -> FlagSet` with remote eval + local (in-process) eval at cross-tree parity with the TS node client. Strategy is adapter-internal; enabled config-only via `create_flag_client` / the provider `flags` slot |
| `replay` | N-A by platform (permanent) | Session replay records DOM mutations in a browser; a server-shaped client has no DOM to record. `SessionReplayPort \| None`, always `None` (`ports.py` / `provider.py`) — documented platform omission, not a silent gap |

Counts: **10 mapped verbs** — 6 direct-analog (`track`, `optIn`, `optOut`, `hasOptedOut`, `flush`,
`shutdown`) + 4 idiomatic-adaptation (`identify`, `setTraits`, `group`, `flags` — the last now backed
by a real server flag client, remote + local eval) · **5 N-A-by-platform** (`page`, `reset`,
`register`, `unregister`, `replay`) · **0 declared-but-unimplemented slots** = the fifteen reference
members, one disposition each. (`flags` graduated from a declared-only slot to an implemented
capability with E12 remote eval + E13 local eval; `replay` moved from a declared-only slot to
N-A-by-platform — a browser-only DOM recorder has no server home, so the slot is permanently `None`,
a final boundary not a pending one. `provider.py`'s docstring stays the source of truth for the
frozen-15 accounting.) `register`'s **runtime verb** is N-A server-side; its **capability** survives
as the construction-time `super_properties` lever (the idiomatic adaptation noted in its row).

### Query primitives — direct-analog

The read surface maps one-to-one; only the naming is idiomatic. The four structured primitives return
**documented per-primitive neutral rows** (snake_case here vs. camelCase on the TS surface — see
[Query verbs → the query read client](#query-verbs--the-query-read-client) for each row shape);
`raw_query` alone keeps the default column-keyed pass-through.

| Reference primitive | Disposition | Python surface |
| --- | --- | --- |
| `funnel` | direct-analog | `funnel(FunnelSpec)` → rows of `{ step, event, count, conversion_rate, breakdown? }` |
| `retention` | direct-analog | `retention(RetentionSpec)` → rows of `{ cohort, period_index, value, breakdown? }` |
| `trend` | direct-analog | `trend(TrendSpec)` → rows of `{ bucket, value, breakdown? }` |
| `uniqueCount` | direct-analog | `unique_count(UniqueCountSpec)` → rows of `{ bucket, value, breakdown? }` (its own named row concept) |
| `rawQuery` | direct-analog | `raw_query(expr)` — the one dialect escape hatch; the dialect is a **value** (a string), never a type; keeps the default verbatim column-keyed row |

### N-A-by-platform mechanisms — by-design server-shaped omissions

Beyond the four N-A facade verbs above, these browser-only **mechanisms** have no server home. Each
is a documented omission, not a gap:

| Browser mechanism | Why N-A server-side |
| --- | --- |
| browser persistence (cookie / local storage) | no per-user client store; identity is a per-call argument |
| autocapture | no DOM to observe |
| pageviews | no page/navigation surface |
| cross-subdomain cookies | no cookies at all |
| beacon-on-unload send | no page-unload lifecycle |
| anonymous→identified merge | no persisted anonymous identity to merge from |
| runtime `register` / `unregister` | no runtime super-property store — `register` becomes the construction-time dict, `unregister` has no analog |
| browser transport | the server uses its own batch-POST delivery, not a browser transport |
| reserved-event-name set + persistence-key prefix | both guard a browser persistence substrate the server lacks — the server reserves **no** event names and uses **no** persistence-key prefix, so a consumer may freely declare any event name |
| set / group trait-shape validation | prop-type validation is **capture-scoped** server-side (the event name selects the prop shape — the one runtime-value dependency); trait and group bags are key-gated by the allowlist but not trait-shape-validated (see `provider.capture`) |
| session replay (`replay?` slot) | records DOM mutations (rrweb) in a browser; a server-shaped client has no DOM to record. The `SessionReplayPort` **type** stays declared on the seam (`ports.py`) for surface parity, but the provider `replay` attribute is permanently `None` (`provider.py`) — a final platform boundary, not a pending slot (no future Python cycle fills it) |

### Taxonomy typing — a stated guarantee gap

The typed taxonomy reaches **runtime-registry parity + best-effort static typing — not** the TS
compile-time guarantee. State the gap, don't hide it:

| Guarantee | TypeScript | Python |
| --- | --- | --- |
| compile-time event-name / prop-shape typing | yes — literal-union mapped types infer the shape from a single taxonomy value | **best-effort static + runtime validation** — no const generics, so per-event prop shapes are checked only where the consumer hand-authors a typed view; the runtime registry (`define_taxonomy` + capture-time validation) is full fidelity |

The runtime registry catches a wrong-typed declared prop at capture time regardless; the static layer
is the honest gap, documented in `taxonomy.py`.

## Interface → implementation matrix

Every neutral verb maps to a shipped, de-branded implementation described **by role and wire shape**
(never by vendor) — plus the cell a future warehouse / self-hosted adapter fills. A new backend is
genuinely fill-in-the-blanks: satisfy the SPI method, fill the future cell.

### Provider verbs → the server capture target

The server target's delivery is a background batch consumer that gzip-POSTs a `{api_key, batch,
sent_at}` envelope to the configured ingest host + path. Each minted event carries a top-level
idempotency `uuid` (the neutral `dedupe_id`, defaulted per call when unset).

| Verb | Shipped implementation (by role / wire shape) | Future warehouse / self-hosted cell |
| --- | --- | --- |
| `capture` | mints a neutral event, gates it (consent → allowlist → capture-scoped prop validation), enqueues it onto the batch consumer; delivery gzip-POSTs the `{api_key, batch, sent_at}` envelope to the configured ingest host + path | satisfy `AnalyticsAdapter.capture(event)` — accept the already-minted neutral event and persist / forward it however the backend ingests |
| `set` | mints a person-props update (nested `set` / `set_once` wrapper) routed through the one capture path, discriminated structurally, not by name | `AnalyticsAdapter.capture` — recognize the person-props update by its structural discriminant and apply it to the person store |
| `set_group_traits` | mints a group-props update (nested group-type / group-key / group-set wrapper) through the same capture path | `AnalyticsAdapter.capture` — recognize the group update by its discriminant and apply it to the group store |
| `opt_in` / `opt_out` / `has_opted_out` | flip / read an instance-level in-memory send switch; each verb short-circuits before minting when opted out (drop-and-discard) | none required at the adapter — consent is enforced above the adapter; a backend inherits it for free |
| `flush` | synchronous drain-to-completion: blocks until the batch consumer's drain returns | satisfy `AnalyticsAdapter.flush()` — force-send buffered work and return only when drained |
| `shutdown` | synchronous drain + quiesce for process exit, bounded by the configured shutdown timeout | satisfy `AnalyticsAdapter.shutdown()` — drain, quiesce, and return |

### Query verbs → the query read client

The shipped read backend translates each spec into an adapter-internal query body, POSTs it to the
configured query endpoint with Bearer-key auth, and resolves the response synchronously (an immediate
result, or a bounded blocking poll for an async status) into a `QueryResult`. The four structured
primitives (`funnel` / `retention` / `trend` / `unique_count`) return **documented per-primitive
neutral rows** — the adapter flattens the backend's insight shapes into a narrowed
`QueryResult[TRow]` whose snake_case row fields are the contract consumers key on (no engine-internal
key leaks); `raw_query` alone keeps the default column-keyed mapping as a verbatim pass-through. All
dialect vocabulary is sealed inside the adapter — it never reaches the neutral surface. The row
shapes below satisfy the language-neutral [`../planning/QUERY-ROW-CONTRACT.md`](../planning/QUERY-ROW-CONTRACT.md)
(the source of truth both trees port to, cased snake_case here vs. camelCase on the TS surface); the
per-primitive wire→neutral-row fixtures at
[`tests/query_contract_fixtures.py`](tests/query_contract_fixtures.py) are its executable form,
mirroring the TS `query-contract.fixtures.ts` values cell-for-cell.

| Verb | Shipped implementation (by role / wire shape) | Future warehouse / self-hosted cell |
| --- | --- | --- |
| `funnel` | translates `FunnelSpec` (ordered steps + window + optional breakdown) into the query body, POSTs to the configured query endpoint with Bearer-key auth, normalizes the response into `QueryResult[FunnelStepRow]` — rows of `{ step, event, count, conversion_rate, breakdown? }` (one row per funnel step; `conversion_rate` is computed relative to the first step, per-group when broken down) | satisfy `AnalyticsQueryClient.funnel` — emit ordered step-completion counts over the taxonomy-typed view restricted to the window; normalize into the same neutral rows |
| `retention` | translates `RetentionSpec` (cohort + return event, bucketed horizon) into the query body, same POST, normalizes into `QueryResult[RetentionRow]` — rows of `{ cohort, period_index, value, breakdown? }` (one row per cohort×period cell; `period_index` 0 is the cohort's own period) | satisfy `.retention` — self-join cohort vs return rows bucketed by granularity for the period count; normalize into the same neutral rows |
| `trend` | translates `TrendSpec` (event + aggregation + window) into the query body, same POST, normalizes into `QueryResult[TrendRow]` — rows of `{ bucket, value, breakdown? }` (one row per time bucket; one row-series per `breakdown` when present) | satisfy `.trend` — a time series over the window at the derived interval, aggregated per the spec; normalize into the same neutral rows |
| `unique_count` | translates `UniqueCountSpec` (event + window) into the query body, same POST, normalizes into `QueryResult[UniqueCountRow]` — rows of `{ bucket, value, breakdown? }` (same neutral row shape as `trend` — a trend with distinct-id math, kept its own named row concept) | satisfy `.unique_count` — count distinct actors over the window; normalize into the same neutral rows |
| `raw_query` | passes the dialect **value** (a string) through as the query body, same POST; keeps the default `QueryResult` row — a verbatim column-keyed mapping whose keys are the consumer's own SELECT projection (the one place a dialect-keyed shape legitimately surfaces); the escape hatch is for the query language only | satisfy `.raw_query` — pass the expression to the backend's own dialect and normalize the result into the default column-keyed `QueryResult` |

The `WarehouseQueryAdapter` typed stub is the concrete second-adapter proof: it satisfies the same
`AnalyticsQueryClient` seam by shape (each method typed, bodies as the fill-in seat), so a
SQL-over-warehouse backend is one adapter, zero consumer change — the future cells above are its
per-method SQL mapping.

## Adopt in a new app

A new consuming app adopts this library **by configuration alone — zero edits under
`src/analytics_kit/`** (bar B). Every lever below is something the consumer supplies; the library owns
the mechanism. The runnable reference for the whole path is the example under
[`examples/quillstream`](examples/quillstream/).

Install the library as a dependency, then wire each lever:

1. **Ingest key** — supply `key` on `AnalyticsConfig`. Presence drives selection: a keyed config
   builds the server target; an **unkeyed** config yields a whole-stack silent no-op (a working but
   silent stack from config alone — the bar-B default). *Consumer supplies the key; the library owns
   selection.*

2. **Super-properties** — supply `super_properties` (a dict) on `AnalyticsConfig`. The library merges
   them into every captured event (this is where the reference `register` capability lives —
   construction-time, not a runtime verb). *Consumer supplies the values; the library owns the merge.*

3. **Typed taxonomy** — author a taxonomy with `define_taxonomy({...})` (your own event names,
   traits, groups — the library ships none) and pass it on `AnalyticsConfig.taxonomy`. At capture
   time the event name selects its declared prop shape and a wrong-typed prop is caught. For static
   typing, hand-author a typed view `Protocol` and apply it with `cast` (a runtime no-op) — the
   best-effort static recipe in `taxonomy.py`. *Consumer declares the vocabulary; the library owns
   the runtime validation.*

4. **Payload allowlist** — supply `allowlist` (a list of permitted top-level keys) on
   `AnalyticsConfig`; only these keys may leave the app. Compose it from your taxonomy with
   `derive_allowlist_from_taxonomy(taxonomy)` (which covers your declared **events, traits, and
   groups** — not page props, which the server has none of) spread alongside any super-property or
   request-tag keys you emit. A `None` allowlist is inactive; an explicit empty list is active
   (allow-nothing). *Consumer supplies the permitted keys; the library owns enforcement.*

5. **Violation policy** — supply `on_violation` on `AnalyticsConfig`: `"throw"` raises on an off-list
   or wrong-typed prop, `"drop-and-error-log"` emits one error and drops the event. The same policy
   backs both the allowlist gate and the taxonomy validator. *Consumer chooses the policy; the library
   owns the guard.*

6. **Query endpoint + read key** — for the read surface, supply a separate `QueryClientConfig`
   (`query_endpoint`, `personal_key`, `project_id`) and build a client with `create_query_client(...)`.
   The read key is a **distinct credential** from the ingest key, kept apart by construction. Unkeyed
   (or keyed-but-endpointless) yields the silent query no-op. Define your KPIs as the five spec-typed
   primitives (`funnel` / `retention` / `trend` / `unique_count` / `raw_query`). *Consumer supplies the
   endpoint, read key, and specs; the library owns the wire translation and decode.*

7. **Framework wiring** — for per-request server integration, use the optional
   `analytics_kit.integrations` bindings: a request-scoped context (`new_context` / the middlewares) +
   the context accessors (`set_context_distinct_id`, `add_tag`) + a context-aware capture view via
   `context(analytics)`. A middleware opens the scope; a handler binds the request's `distinct_id` and
   any tags, then captures through the scoped view. *Consumer wires the middleware and binds per-request
   identity; the library owns the context propagation.*

**The bar-B invariant.** A new app adopts through the public `analytics_kit` surface with **zero edits
under `src/analytics_kit/`** — config, taxonomy, and allowlist alone. The example under
[`examples/quillstream`](examples/quillstream/) proves it: it supplies every product specific through
config and reaches the library through its public API only, gated by an installed-distribution
type-check plus a public-API-only import audit (see that example's README).

## Self-host recipe: run the loop on your own Neon

At **parity with the TS self-host recipe** (`../ts/README.md`), adapted for a server shape. The
library ships **two selectable backends behind the same seam**, neither privileged in the code:

- **the default HTTP backend** — an ingest host + project key write the batch wire and a query
  endpoint serves the reads;
- **the self-host warehouse backend** — capture → store → query runs entirely against **your own
  Neon Postgres**, with **zero HTTP calls to any hosted analytics service**.

This is the provider-swap walkthrough for the self-host backend. It is **provisioning and
configuration, not config-only magic**: you provision a database, run a migration, install a driver
extra, author your flag definitions, and mount a handler. None of it edits the library.

### What you provision (the honest prerequisites)

1. **A Neon Postgres database and its DSN.** You create it; the library never provisions
   infrastructure.
2. **The migration, run once against that database.** The library generates the DDL; you execute it.
3. **The warehouse driver extra, installed.** The Postgres driver ships behind the optional
   `analytics-kit[warehouse]` extra (psycopg v3) so the package imports without a warehouse present.
4. **Your static flag definitions, authored.** The zero-infra flag posture evaluates in-process from
   definitions you write.
5. **A mounted receiver handler.** The write endpoint is a handler you mount on your own server.

**Postgres ≥16 is required.** The generated typed view uses `pg_input_is_valid`, a Postgres-16
function, for its safe casts — a Postgres-15 database gets a view that **errors at creation**. Neon
runs 16/17/18, so a fresh Neon database satisfies the floor. State this to your operator before you
provision.

### 1. Run the migration against your Neon

`build_migration_sql(taxonomy)` returns the idempotent migration for **your** taxonomy: the fixed
`events` table DDL followed by a generated typed view (one safe-cast column per declared event
property). It emits a SQL string and executes nothing — run it against your Neon DSN with your own
migration tooling. Re-running is safe (`CREATE TABLE IF NOT EXISTS` + `CREATE OR REPLACE VIEW`).

```python
from analytics_kit import build_migration_sql

sql = build_migration_sql(taxonomy)  # run this string against your Neon database once
```

The typed view is generated from the **same taxonomy** you already declared for capture — one
vocabulary, both the write shape and the queryable columns.

### 2. Install the warehouse driver extra

The default warehouse driver is the optional `analytics-kit[warehouse]` extra (psycopg v3). The
package imports clean without it (the driver loads only when the default driver is constructed), so
only a self-host consumer takes the dependency:

```sh
pip install 'analytics-kit[warehouse]'   # your dependency manager of choice
```

### 3. Supply `warehouse_dsn` — the single self-host signal

Selection is **by field presence, not a `backend:` enum**. Supplying `warehouse_dsn` is the one
signal that selects the warehouse query adapter and the DSN-backed receiver; absent it, the same
factories select the HTTP backend or a silent no-op. `create_query_client`
(`src/analytics_kit/query/factory.py`) routes to the warehouse adapter the moment a `warehouse_dsn` is
present:

```python
from analytics_kit.query import create_query_client, QueryClientConfig

queries = create_query_client(
    QueryClientConfig(warehouse_dsn=os.environ["WAREHOUSE_DSN"])  # presence selects the warehouse read path
)
```

The same taxonomy, identity handling, allowlist, and event names you use for the default backend
carry over **unchanged** — only this one config field differs.

### 4. Author your static flag definitions (zero-infra, local-only)

The self-host flag posture evaluates flags **in-process** from definitions you author — no flag
service, no flag-definitions endpoint, no network round-trip. Supply your neutral
`FeatureFlagDefinition` list on `static_definitions` and set `only_evaluate_locally=True`; the client
polls nothing and evaluates every flag against the `FlagContext` locally
(`src/analytics_kit/flags/factory.py`):

```python
from analytics_kit.flags import create_flag_client, FlagClientConfig

flags = create_flag_client(
    FlagClientConfig(
        key=os.environ["ANALYTICS_KEY"],
        static_definitions=my_flag_definitions,  # list[FeatureFlagDefinition] you author
        only_evaluate_locally=True,              # in-process only; zero flag-service calls
    )
)
```

An empty `static_definitions` set seeds an empty, flags-off client — supply at least one definition. A
malformed set raises at client construction, not lazily at first eval.

### 5. Mount the receiver

The write endpoint is a **receiver** you mount on your own server. `create_receiver_from_config`
(`src/analytics_kit/receiver/factory.py`) reads the DSN, builds the default driver from it, and returns
a framework-agnostic `Receiver`. Hand that `Receiver` to the mount for your framework — a Django view
(`make_receiver_view`) or a terminal ASGI app (`ReceiverASGIApp`, mountable under FastAPI / any ASGI
server):

```python
from analytics_kit.receiver import create_receiver_from_config, ReceiverASGIApp, ReceiverConfig

receiver = create_receiver_from_config(ReceiverConfig(warehouse_dsn=os.environ["WAREHOUSE_DSN"]))
app.mount("/ingest", ReceiverASGIApp(receiver))  # your route, your server
```

A receiver with **no** `warehouse_dsn` raises a clear neutral error at construction rather than
silently accepting and dropping events — a write with nowhere to go is a misconfiguration, not an
empty-success.

### Same app code, only the config differs (Bar A + Bar B)

The self-host config uses the **same taxonomy, identity handling, allowlist, and event names** as the
default-backend config. **No consumer code changes** — the call sites (`capture` / `set` /
`set_group_traits` / the query primitives) are unchanged across the swap. Only the configuration and
the mounted handler differ:

- **Bar A** (provider-swap = one adapter, zero consumer change): the warehouse adapter and the
  DSN-backed receiver are the "one adapter"; every call site stays put.
- **Bar B** (new-app adoption = config only, zero library change): a new app stands up self-host by
  **config + migration + mount** — nothing under `src/analytics_kit/` is edited.

The default backend stays **one selectable backend among two** — not the default-by-privilege, not
the only one. Self-host is selected purely by supplying `warehouse_dsn`.

### Query-time expectations (self-host reads)

Two behaviors are inherent to running SQL over your own Postgres — expectations to know, not
defects:

- **`text → timestamptz` casts are session-dependent for ambiguous inputs.** A timestamp string with
  an ambiguous field order is resolved against the session's `DateStyle` / `TimeZone` settings. This
  is inherent to the cast, not an error — pin those session settings if your ingested timestamps are
  ambiguous.
- **The retention breakdown groups per `(distinct_id, cohort_bucket, value)`.** An actor with two
  breakdown values in one cohort week lands in **both** breakdown cohorts — one row per distinct
  breakdown value, by design.
- **Breakdown keys must be declared event properties.** A breakdown groups on the taxonomy-declared
  typed-view column; an **undeclared breakdown key raises at query-build time**, before any SQL runs.
  Declare the property in your taxonomy (so the migration projects its column) and the breakdown works
  end to end.
