# History — analytics-kit

Cycle narrative, newest-first. The [ROADMAP](ROADMAP.md) holds the forward plan; this file holds
what closed cycles established and why.

## `Python parity` cycle — closed 2026-07-10 (PY1–PY8)

The library became polyglot: a full Python implementation under `python/` at capability parity with
the shipped TS surface, **server-shaped** (a plain client + framework bindings; no browser/DOM target).
On 2026-07-09 the repo split to `ts/` + `python/`; `planning/` and `.claude/` govern both trees. Parity
is by shared contract, not shared code — the shipped `ts/` seam is the reference the port ports *to*.

- **The seam ported capability-for-capability (PY1–PY3).** uv/pytest/ruff/mypy(strict) scaffold, one
  `analytics-kit` distribution + extras. The neutral seam is `Protocol`s (adapter SPI + a frozen-15
  provider: 13 methods + `flags?`/`replay?` declared `None`-slots), Pydantic at the genuine boundaries,
  the config-selected factory + a whole-stack `NoopAdapter` (unkeyed ⇒ silent). Taxonomy = runtime-registry
  parity + a best-effort static layer (NOT the TS compile-time literal guarantee — the const-generic wall,
  PM-locked); the consumer-supplied payload allowlist is a 1:1 port, gating consumer keys pre-enrichment.
  The adapter SPI is **capture-only** (set/group mint `internal_kind`-discriminated `NeutralEvent`s routed
  through `capture`).

- **Server capture + query + framework bindings (PY4–PY6).** Server capture over a bounded queue +
  daemon-thread consumer, **drop-oldest overflow to match TS (not posthog-python's drop-newest)**, an
  adapter-internal wire mapper (`dedupe_id`→wire `uuid`; de-branded `set`/`set_once`/`group_*` wrappers,
  never `$set`/`$groupidentify`), retry classification + 413-halving + fetch-failure normalization. The
  query client (funnel/retention/trend/unique-count + `raw_query`) over a sync HTTP adapter + a warehouse
  stub (bar-A). The React analog: `contextvars` request scope + `@scoped` + Django + ASGI/FastAPI
  middleware behind extras.

- **Example consumer + parity audit (PY7–PY8).** Quillstream proves bar B via the architect-locked
  **TWO-gate model** — fidelity (installed-dist mypy) + enforcement (AST import-audit, public-API-only) —
  since Python has no physical `dist` boundary like TS Fernly's typecheck-against-`dist`. The capstone
  audit: a capability-parity matrix vs the TS surface (browser-N-A rows AND the distinct `flags?`/`replay?`
  declared-slot rows, no silent gap), the Python neutrality-scan analog (fully-extracted wheel+sdist +
  `ast` `_WIRE_*` wire-confinement) as a standing zero-vendor gate, and real-stack loopback probes +
  negative controls ground-truthed vs `posthog-python` source. Both acceptance bars re-proven.

- **Post-cycle reliability fix (PR review).** The audit's real-stack probe was transient-only (503),
  missing that `urllib` raises `HTTPError` on **every** non-2xx — which the transport normalized to a
  transient `0`, making a permanent `400` retry-then-drop and 413-halving dead code. Fixed (catch
  `HTTPError` → real status; network errors still normalize to `0` at the boundary, matching TS's `fetch`
  semantics), with loopback regression tests across permanent / halving / transient statuses. Lesson
  carried forward: a real-stack probe must exercise the permanent/error path, not just a transient one.

Epics archived to [`epics/done/`](epics/done/): PY1-NODE-python-scaffold, PY2-CORE-python-seam,
PY3-CORE-taxonomy-allowlist, PY4-NODE-server-capture, PY5-QRY-query-client, PY6-RCT-framework-bindings,
PY7-CORE-example-consumer, PY8-OBS-parity-audit.

## `R1 targets` cycle — closed 2026-07-09 (E4–E11)

The three platform targets + example consumer + adoption audit brought the library to
capability-complete against the BRIEF contract, on top of the `core` seam. Build order honored every
`blocked_by`: E4 → E5 → E6 → E7 → E8 → E9 → E10 → E11. **Frozen-15 held across all eight epics** —
no new facade verb was added anywhere.

- **Browser target (E4 identity · E5 transport · E6 capture/enrichment).** Anonymous UUIDv7 distinct
  id + separate device id, config-selectable persistence (`cookie` | `localStorage+cookie` |
  `memory`), cross-subdomain cookies, anonymous→identified merge (rides `identify()`), allowlist-gated
  super-property registration, session id + expiry, durable tri-state consent
  (`granted`/`denied`/`pending`, DNT-folded), `reset()`. Transport: batching (time + size), gzip
  (native `CompressionStream` + fflate fallback), retry with backoff+jitter (network/5xx only),
  offline queue that survives reloads (the one BRIEF §4 gap PostHog doesn't fill), fetch→XHR→sendBeacon
  + keepalive/unload drain, client rate-limiter, bot filtering, `dedupeId`→wire `uuid`. Capture:
  `track`/`page`/adapter-internal pageleave, fresh-per-event page + UTM + device/referrer context (each
  opt-out-able via one `enrichment` object), pluggable country source, DOM autocapture (default OFF),
  per-context capture profiles (`context()` → narrower `ScopedAnalytics`).

- **Node target (E7 capture · E8 query).** Standalone `@analytics-kit/node`: server-side `capture`
  (required `distinctId`) + `setTraits`/`setGroupTraits`, caller-suppliable `dedupeId`, in-memory batch
  (drop-oldest) + gzip `{api_key,batch,sent_at}` + 413-halving, shared `enforceAllowlist` (bar A: one
  code path), unkeyed whole-stack no-op (bar B), `flush()`/`shutdown()`. Query: neutral
  `AnalyticsQueryClient` (funnel/retention/trend/uniqueCount + `rawQuery` escape hatch, taxonomy-typed
  → flat `QueryResult`); `HttpQueryAdapter` (sync + bounded async poll, Bearer auth);
  `WarehouseQueryAdapter` typed stub = the bar-A proof (two adapters, one interface, seam unchanged);
  `QueryNoop` (bar B). Server-only `QueryClientConfig` distinct from ingest.

- **React target (E9).** Optional `@analytics-kit/react`: SSR-safe `AnalyticsClientProvider`
  (create-once, discriminated `client` XOR `config`), `useAnalytics<TX>()` (taxonomy through the hook,
  sentinel-throws outside a provider), optional router-agnostic `usePageView<TX>()`. Peer-dep react +
  browser.

- **Example consumer (E10 — Fernly) + adoption audit (E11).** Fernly (`examples/`) proves config-only
  adoption (bar B) — one taxonomy exercising every surface (browser merge/contexts/allowlist + node
  capture + query snapshots + React binding), zero `packages/**` changes. `examples/fernly` is a
  workspace member whose `turbo typecheck`-against-`dist` gate IS the bar-B proof. E11 (the capstone):
  a CI-able exit-nonzero neutrality scan (`scripts/neutrality-scan.ts`, scan-by-dimension over `dist`
  + `$`-wire confinement), the README interface→implementation matrix + adopt-in-a-new-app guide,
  re-runnable gated proofs of BOTH bars, and a capability-completeness audit vs the BRIEF (flags/replay
  are by-design-omitted rows, no silent gap).

- **Hardened post-ship (four review rounds, 2026-07-09).** R1 shipped all-gates-green but the browser
  target carried real defects the self-consistent tests had *encoded as correct*. Four external review
  rounds fixed ~30: a vendor leak in `dist` (`HogQLQuery`), zero browser ingestion (no api_key reached
  the wire), privacy/consent violations, identity/data-loss, and name collisions reintroduced by
  de-branding (`$groups`→`groups`). The durable fixes were class-level, not per-instance:
  persistence-vs-capture verb routing at the facade, the `__ak_` reserved-prefix + `internalKind`
  structural discriminants, consent single-sourced in `consent-policy.ts`, memory→durable promotion on
  opt-in, and the neutrality scan extended to the compiled js bundle. **Lesson recorded: all-gates-green
  ≠ correct** — "done" requires real-stack probes + negative controls + ground-truthing vs `posthog-js`.

- **Deferred product decision:** the explicit-denial stance. Because persistence verbs now land in the
  memory store while opted-out, a user who explicitly *denies* then later grants has their denial-time
  `identify`/`register`/`group` resurrected to durable storage on opt-in. Correct for *pending*
  (undecided banner); arguable for *explicit denial* (you may want denial to discard). Currently
  resurrects; a small targeted change if denial should drop.

Epics archived to [`epics/done/`](epics/done/): E4-ID-identity-persistence, E5-CAP-transport,
E6-CAP-capture-enrichment, E7-NODE-server-capture, E8-QRY-query-client, E9-RCT-react-binding,
E10-CORE-example-consumer, E11-CORE-adoption-audit.

## `core` cycle — closed 2026-07-08 (E1, E2, E3)

The vendor-neutral seam reached v1. The cycle stood up the workspace and settled the two
load-bearing shapes every downstream area now builds on.

- **Seam shape settled (E2).** Two objects, one boundary: the consumer-facing `AnalyticsProvider`
  facade (owns taxonomy typing, allowlist guard, consent gating, neutral-event construction) holds
  an `AnalyticsAdapter` SPI (the minimal neutral contract a backend satisfies — `fetch` transport,
  persisted-property get/set, client identity, plus neutral capture/identify/group/alias +
  flush/shutdown over neutral event objects). No `$`-names and no `/batch/` envelope leak onto the
  SPI; batching/transport/persistence stay adapter-internal. "Unkeyed ⇒ silent" is a whole-stack
  `NoopAdapter` null-object, not a `disabled` flag. The per-event dedupe/insert-id field was fixed
  to the neutral `dedupeId` name (maps to the wire top-level `uuid`) so browser and node idempotency
  cannot diverge. `FeatureFlagPort` / `SessionReplayPort` are declared-but-unimplemented optional
  capability slots — `undefined` in release 1.

- **Library-own privacy + typing surface settled (E3).** `defineTaxonomy()` returns a runtime
  object that both brands the compile-time type and powers the runtime key registry — one
  declaration drives typing and the allowlist. The payload allowlist runs synchronously at the
  facade call-boundary, **pre-enrichment** (the inverse position of PostHog's post-enrichment
  `before_send`), throws on an off-list consumer key by default, and holds identically for every
  adapter. Rule fixed here: keys the library **computes** are trusted; keys/values the consumer
  **supplies** are gated. Neither the taxonomy generic nor the allowlist exists in `posthog-js` —
  this is entirely the library's own surface.

- **Both acceptance bars proven at the seam.** Bar A (provider-swap = one adapter, zero consumer
  change) holds via the SPI; bar B (new-app = config only) holds via the preserved untyped
  `createAnalytics({}).track('x')` path.

- **Reference-backend decision recorded (T1).** Out-of-cycle but settled alongside: the release-1
  reference backend defaults to **T1 = Neon Postgres only**, storage-agnostic and graduation-additive,
  with everything below the adapter seam (storage, query computation) kept backend-internal. See
  [`REFERENCE-BACKEND.md`](REFERENCE-BACKEND.md).

Epics archived to [`epics/done/`](epics/done/): E1-CORE-workspace-scaffold,
E2-CORE-provider-seam, E3-CORE-taxonomy-allowlist.
