# analytics-kit — Python

The Python implementation of the vendor-neutral analytics library. Sibling to the TypeScript
implementation under [`../ts/`](../ts/); the two stay at **capability parity** — every capability the
TS surface exposes must be reachable here, adapted idiomatically (server-shaped: a plain client +
framework bindings; **no browser/DOM target**).

The seam is built: a `Protocol`-based provider contract and adapter SPI, a typed taxonomy, the
consumer-supplied allowlist, a config-selected factory, a server capture target, the query read
client, and the optional framework bindings — all reachable through the public `analytics_kit`
surface. The `flags?` slot is **implemented** — a server flag client with remote eval and local
(in-process) eval at cross-tree parity with the TS node client; the `replay?` slot stays declared
but unfilled this release. The sections below map every capability to the TS surface, map every verb
to its shipped implementation, and walk config-only adoption.

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
into exactly one of four dispositions here — **no silent gap**:

- **direct-analog** — same verb, same shape;
- **idiomatic-adaptation** — the same capability, re-expressed for a server (fewer verbs, a
  construction-time lever);
- **N-A by platform** — a browser-only mechanism with no server home, omitted **by design** (not a
  gap);
- **declared-but-unimplemented slot** — a capability port declared on the seam but unfilled this
  release (a slot awaiting its owning cycle — distinct from an N-A omission).

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
| `replay` | declared-but-unimplemented slot | `SessionReplayPort \| None`, defaulting to `None` this release (`ports.py`) |

Counts: **10 mapped verbs** — 6 direct-analog (`track`, `optIn`, `optOut`, `hasOptedOut`, `flush`,
`shutdown`) + 4 idiomatic-adaptation (`identify`, `setTraits`, `group`, `flags` — the last now backed
by a real server flag client, remote + local eval) · **4 N-A-by-platform** (`page`, `reset`,
`register`, `unregister`) · **1 declared-but-unimplemented slot** (`replay`) = the fifteen reference
members, one disposition each. (`flags` graduated from a declared-only slot to an implemented
capability with E12 remote eval + E13 local eval; `provider.py`'s docstring stays the source of truth
for the frozen-15 accounting.) `register`'s **runtime verb** is N-A server-side; its **capability**
survives as the construction-time `super_properties` lever (the idiomatic adaptation noted in its
row).

### Query primitives — direct-analog

The read surface maps one-to-one; only the naming is idiomatic.

| Reference primitive | Disposition | Python surface |
| --- | --- | --- |
| `funnel` | direct-analog | `funnel(FunnelSpec)` |
| `retention` | direct-analog | `retention(RetentionSpec)` |
| `trend` | direct-analog | `trend(TrendSpec)` |
| `uniqueCount` | direct-analog | `unique_count(UniqueCountSpec)` |
| `rawQuery` | direct-analog | `raw_query(expr)` — the one dialect escape hatch; the dialect is a **value** (a string), never a type |

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

### Declared-but-unimplemented capability slots

Distinct from N-A: `replay` is **declared** on the seam as an optional capability port, awaiting its
owning cycle — a `Protocol` slot defaulting to `None`, parity-present as a slot exactly as the TS
surface declares it unfilled this release. (`flags` was such a slot; it is now **implemented** —
a server flag client with remote + local eval, populated config-only via the provider `flags` slot.)

| Slot | Declared as | State |
| --- | --- | --- |
| `replay` | `SessionReplayPort` (`ports.py`), `replay` attribute defaults to `None` (`provider.py`) | declared, unfilled — browser-shaped in practice, held as a slot for surface parity |

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
result, or a bounded blocking poll for an async status) into one flat `QueryResult`. All dialect
vocabulary is sealed inside the adapter — it never reaches the neutral surface.

| Verb | Shipped implementation (by role / wire shape) | Future warehouse / self-hosted cell |
| --- | --- | --- |
| `funnel` | translates `FunnelSpec` (ordered steps + window + optional breakdown) into the query body, POSTs to the configured query endpoint with Bearer-key auth, decodes to `QueryResult` | satisfy `AnalyticsQueryClient.funnel` — emit ordered step-completion counts over the taxonomy-typed view restricted to the window; normalize rows/columns into `QueryResult` |
| `retention` | translates `RetentionSpec` (cohort + return event, bucketed horizon) into the query body, same POST + decode | satisfy `.retention` — self-join cohort vs return rows bucketed by granularity for the period count; normalize into `QueryResult` |
| `trend` | translates `TrendSpec` (event + aggregation + window) into the query body, same POST + decode | satisfy `.trend` — a time series over the window at the derived interval, aggregated per the spec; normalize into `QueryResult` |
| `unique_count` | translates `UniqueCountSpec` (event + window) into the query body, same POST + decode | satisfy `.unique_count` — count distinct actors over the window; normalize into `QueryResult` |
| `raw_query` | passes the dialect **value** (a string) through as the query body, same POST + decode; the escape hatch is for the query language only — the result contract stays the flat `QueryResult` | satisfy `.raw_query` — pass the expression to the backend's own dialect and normalize the result into `QueryResult` |

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
