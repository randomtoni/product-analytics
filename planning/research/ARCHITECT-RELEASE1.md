# Architecture memo — analytics-kit release 1

_Author: architect agent · 2026-07-07 · Canonical scope: `planning/BRIEF.md` (wins over any older doc)._

This memo answers the load-bearing design questions for epics E1–E11, one section per epic, so the
PM/refiner agents can plan against decided shapes. Every section gives: **Recommendation** ·
**Rejected alternatives (with reasons)** · **Confidence** · **Citations** into the local `posthog-js`
reference checkout (`posthog-js/packages/…:LINE`, read at HEAD).

## Reading notes & standing posture

- **posthog-js is a reference we port from and de-brand, never a dependency.** Every citation below
  is "how PostHog does it," not "what we ship." The library's own code, API, type names, package
  names, file names, and docs carry **zero** vendor references; ported code is neutralized (PostHog
  naming stripped, vendor endpoints/keys → configuration).
- **Two layers, and the neutral-seam bias.** For any question I split **adapter-internal mechanics**
  (PostHog wire/SDK behavior — answerable authoritatively from source) from the **vendor-neutral
  consumer surface** (the interface *any* backend must satisfy — NOT settled by copying PostHog).
  Sections that touch the neutral seam are flagged **[SEAM]** and lead with that split.
- **`$`-prefixed names, `/batch/`, `$identify`, `quota_limited`, region routing, the `$sesid`
  tuple, etc. are PostHog-wire-specific.** They live *inside* an adapter and are normalized away
  before anything reaches the neutral consumer surface. I mark these **[WIRE]** inline.
- **The two acceptance bars gate every call:** (A) provider-swap = one adapter, zero consumer
  change; (B) new-app = config only, zero library change.

---

## E1 — Workspace & toolchain scaffold

No open design question — the toolchain is locked (pnpm workspace · turbo · vitest · tsup · tsc
`--noEmit` · eslint flat config) and the package split is decided: `analytics-kit` (seam) +
`@analytics-kit/{browser,node,react}`, no package literally named `core`. One load-bearing
constraint for the scaffold to encode from day one so later epics inherit it: **the seam package
(`analytics-kit`) must not depend on any target package** — dependencies point *inward*
(browser/node/react → seam), never outward, and adapters are internal modules of their target,
named by role. Mirrors posthog-js's own `core ← browser`/`core ← node` direction
(`posthog-js/packages/node/src/client.ts:125` extends `@posthog/core`;
`posthog-js/packages/browser/src/posthog-core.ts:101-116` imports helpers from `@posthog/core`).
**Confidence: high.**

---

## E2 — Core seam: `AnalyticsProvider` facade + adapter SPI + config-selected factory  **[SEAM]**

**Neutral-seam split.** *Adapter-internal:* PostHog's `PostHogCoreStateless` is the closest analogue
to a shared SPI and I lean on it authoritatively. *Neutral surface:* the facade↔adapter contract is
the library's own; I do **not** copy PostHog's `capture/$identify/$groupidentify` method set or its
`/batch/` envelope into the seam — those are wire details that belong inside an adapter.

**Recommendation.**

1. **Two objects, one boundary.**
   - **`AnalyticsProvider` (facade)** — the consumer-facing interface, exactly the BRIEF §1 surface:
     `track` · `identify(id, traits, traitsOnce)` · `page(name?, props?)` · `group(type, key, props)`
     · `reset()` · `setTraits(traits, once?)` · `optIn/optOut/hasOptedOut` · `flush/shutdown`. The
     facade owns everything **backend-agnostic**: taxonomy typing (E3), the allowlist guard (E3),
     consent gating, and neutral-event construction. It holds an adapter and delegates.
   - **`AnalyticsAdapter` (SPI)** — the minimal contract a backend satisfies. Model it on the
     *target-agnostic subset* of PostHog's stateless base — `fetch` (transport),
     `getPersistedProperty/setPersistedProperty` (storage), `getLibraryId/Version/CustomUserAgent`
     (client identity) — which are genuinely neutral
     (`posthog-js/packages/core/src/posthog-core-stateless.ts:247-254`). But the SPI's *verbs* are
     neutral capture/identify/group/alias + flush/shutdown taking **neutral event objects**; the
     adapter internally maps those to the vendor wire. Do **not** surface PostHog's `enqueue`/
     `/batch/` envelope or `$`-names on the SPI.
2. **The facade is thin; the adapter is where the port lands.** Note PostHog's own asymmetry: node
   **extends** `PostHogCoreStateless` and reuses its queue/flush
   (`posthog-js/packages/node/src/client.ts:125`), whereas browser is a **sibling** that
   `implements PostHogInterface` and re-runs its own pipeline
   (`posthog-js/packages/browser/src/posthog-core.ts:389`), sharing only types+utils. Lesson for us:
   batching/transport/persistence are **adapter-internal**, not seam concerns — so the browser and
   node adapters can legitimately differ in mechanics while satisfying the same neutral SPI. Keep the
   SPI about *what a backend must accept*, not *how it queues*.
3. **Config-selected factory + no-op.** `createAnalytics(config)` selects the adapter from config and
   returns a facade wired to it; **when no key is configured it selects a whole-stack `NoopAdapter`**
   (a real object whose methods are silent no-ops, `hasOptedOut()`→true-ish/consistent,
   `flush/shutdown`→resolved promises). Prefer a distinct null-object over PostHog's approach of a
   `disabled` boolean threaded through one class
   (`posthog-js/packages/core/src/posthog-core-stateless.ts:287`
   `disabled = options.disabled ?? false || missingApiKey`) — a null-object keeps the no-op path
   from leaking `if (disabled)` checks across the codebase and makes "unkeyed = silent" a
   type-level guarantee. The no-op must be **whole-stack**: identity/persistence also go to memory
   mode (couples to E4), not just transport.
4. **Typed extension points for feature-flags / session-replay — declared, not implemented.** Define
   the *port types* now in the seam package (e.g. `interface FeatureFlagPort { … }`,
   `interface SessionReplayPort { … }`) and hang them off the provider as **optional** capability
   slots (`analytics.flags?: FeatureFlagPort`, `analytics.replay?: SessionReplayPort`), populated by
   an adapter only if it provides them — `undefined` in release 1. This keeps the type surface
   capability-complete (nothing is "lost" by adopting the library) while shipping zero flag/replay
   logic. Keep them as **separate ports**, never folded into `track/identify`, so the core capture
   surface stays minimal. PostHog bundles flags into its one class
   (`posthog-js/packages/browser/src/posthog-featureflags.ts`) — we deliberately don't.

**Rejected alternatives.**
- *One class implementing everything (PostHog's shape).* Rejected: PostHog's `PostHog` class is
  ~4,200 lines mixing facade, transport, persistence, flags, replay — the opposite of a swappable
  seam; violates bar A (you'd rewrite the class per backend, not write one adapter).
- *SPI = PostHog's exact stateless verbs (`captureStateless`, `$identify`).* Rejected: leaks
  `$`-names and the `/batch/` envelope into the neutral surface; a non-PostHog adapter shouldn't have
  to speak `$identify`.
- *No-op via a `disabled` flag instead of a null adapter.* Rejected: threads a conditional through
  every method; a null-object is cleaner and makes "unkeyed ⇒ silent" structural.

**Confidence: high** (facade/SPI split, factory, no-op) · **med** (exact extension-point signatures —
they should be sketched but not frozen until an adapter needs them).

---

## E3 — Typed taxonomy + allowlist enforcement  **[SEAM]**

**Neutral-seam split.** This is entirely the library's own surface — posthog-js has **no** taxonomy
generic and **no** payload allowlist (its nearest mechanic, `before_send`, is a soft mutate/drop
hook, not a fail-loud key gate). So I answer from engineering judgment, using PostHog only to locate
the analogous pipeline seam.

**Recommendation.**

1. **`defineTaxonomy<T>()` over a bare generic param — because the allowlist needs runtime data.** A
   plain generic (`AnalyticsProvider<TEvents>`) gives compile-time safety but **types erase at
   runtime**, so it can't drive the allowlist. `defineTaxonomy<T>()` returns a value that carries the
   event/prop declaration at runtime *and* brands the type, so one declaration powers **both**
   compile-time typing and the runtime key registry. Shape:
   ```ts
   const taxonomy = defineTaxonomy<{
     events: { checkout_completed: { plan: string; total_cents: number }; … };
     groups: { company: { tier: string } };
   }>({ /* optional runtime schema/keys */ });
   ```
2. **How typing flows.**
   - `track<K extends keyof T['events']>(event: K, props: T['events'][K])` — event name and its prop
     shape are checked together.
   - `group<G extends keyof T['groups']>(type: G, key: string, props: T['groups'][G])`.
   - `page(name?, props?)` — treat as a reserved event entry in the taxonomy (`events['$page']`-
     equivalent, neutral name e.g. `page`) or accept a loose `PageProps`; recommend a reserved
     taxonomy slot so page props are typed too.
   - `identify(id, traits, traitsOnce)` / `setTraits` — traits typed via an optional `T['traits']`
     map (mutable vs set-once share the shape).
3. **Where the allowlist attaches: the facade call-boundary, BEFORE the adapter — fail loud.** The
   guard validates the **consumer-supplied** `props`/`traits` keys against the allowlist synchronously
   inside `track/identify/group/setTraits`, and **throws** on an off-list key by default (configurable
   `onViolation: 'throw' | 'drop-and-error-log'`, default `throw` to honor "fail loudly"). Attaching
   at the facade — not inside the adapter — is load-bearing: the allowlist is a **vendor-neutral
   privacy contract that must hold identically for every adapter** (bar A), so it cannot live where
   each adapter could re-implement or skip it. PostHog's structurally-similar seam is `before_send`,
   which runs as the **last** transform before enqueue and can drop by returning null
   (`posthog-js/packages/browser/src/posthog-core.ts:1453-1462`, impl `:4175-4220`) — but it runs
   *after* enrichment and is a soft filter; ours runs *before* enrichment and is a hard gate. Note
   PostHog's own `property_denylist`/`sanitize_properties` (a denylist, the inverse of our allowlist)
   fire inside property calculation at `:1610-1627`.
4. **Enrichment keys are IMPLICITLY allowed — because they're added downstream of the guard.**
   Decision on the BRIEF's explicit question: **library-generated context keys** (page/UTM/device
   context — PostHog's `$current_url`, `$browser`, … at
   `posthog-js/packages/browser/src/utils/event-utils.ts:293-354`) do **not** need listing. They are
   the library's own de-branded output, they're added inside the browser adapter *after* the facade
   allowlist has run, and each is already independently controllable via E6 per-enrichment opt-outs.
   Forcing consumers to enumerate them invites wildcarding (defeating the allowlist). **Exception —
   consumer-injected enrichment must pass the allowlist:** the country-source value the consumer
   plugs in (E6) carries consumer-provided data, so its key must be on-list. So the rule is: *keys
   the library computes are trusted; keys or values the consumer supplies (event props, traits,
   injected enrichment) are gated.* This falls out naturally from attaching the guard at the facade,
   before library enrichment.
5. **Allowlist source.** A separate explicit `allowlist: string[]` config field, with an optional
   convenience `deriveAllowlistFromTaxonomy(taxonomy)` — keep them separable because global/registered
   super-props exist outside any single event's taxonomy entry.

**Rejected alternatives.**
- *Bare generic type param, no `defineTaxonomy`.* Rejected: no runtime data ⇒ can't drive the
  allowlist; the taxonomy and the privacy gate would be two disconnected declarations.
- *Allowlist inside the adapter (PostHog `before_send` position).* Rejected: each adapter would
  re-implement it; a skipped/weaker impl in a future adapter breaks the privacy contract and bar A.
- *Allowlist runs after enrichment.* Rejected: then enrichment keys must be enumerated or specially
  whitelisted; running before enrichment makes "library keys trusted, consumer keys gated" automatic.
- *Silent drop on violation (default).* Rejected: BRIEF mandates "fails loudly"; throw by default,
  offer drop-and-log as an opt-in for prod resilience.

**Confidence: high.**

---

## E4 — Browser identity & persistence

**Neutral-seam note.** Identity *semantics* (anonymous id, merge, reset, sessions) are largely
universal and belong on the neutral surface; the *encoding* (`$sesid` tuple, `distinct_id==$device_id`
anonymity trick, `ph_` cookie names) is **[WIRE]** and stays inside the browser adapter/persistence.

**Which posthog-js modules to port (minimally), by file.**
- `posthog-js/packages/browser/src/posthog-persistence.ts` — the `PostHogPersistence` class:
  mode selection, register/register_once/unregister, load/save/flush. Five modes at `:45-51`; build
  at `:186-237`; register `:688-707`, register_once `:659-681`, unregister `:709-714`; save-debounce +
  beforeunload flush `:415-452`, `:166-170`.
- `posthog-js/packages/browser/src/storage.ts` — the backends: `cookieStore._set` (expiry, SameSite,
  secure) `:133-172`; **cross-subdomain domain resolution** `chooseCookieDomain`/
  `seekFirstNonPublicSubDomain` `:76-92`, `:39-68` (walks labels, probes public-suffix via cookie
  acceptance); `localStore` `:191-260`; `createLocalPlusCookieStore` (durable localStorage +
  best-effort cookie mirror of identity keys) `:284-356`; `memoryStore` `:361-386`;
  `sessionStore` `:393-456`.
- `posthog-js/packages/browser/src/sessionid.ts` — `SessionIdManager` (session id/expiry).
- `posthog-js/packages/browser/src/session-props.ts` — session entry attribution (needed by E6, but
  the session-id plumbing is E4).
- `posthog-js/packages/core/src/cookie.ts` — shared cookie read/write + the anonymous-vs-identified
  cookie state helpers `:55-140` **[WIRE]** on names.
- Identity logic itself lives in `posthog-js/packages/browser/src/posthog-core.ts` (identify/reset/
  register) — port the *logic*, re-house it behind the adapter (not a giant class).

**Recommendation — decisions.**
1. **Persistence modes: support `memory` and a durable browser mode; default to a
   localStorage+cookie split, not pure cookie.** The BRIEF frames it as "cookie (default) vs memory,"
   but PostHog itself moved its default from `'cookie'` to **`'localStorage+cookie'`** as of >1.92.0
   (`posthog-js/packages/browser/src/posthog-core.ts:235`, with the in-line migration comment)
   precisely because pure cookies hit the ~4 KB limit (`storage.ts:162-164` warns near
   `4096*0.9`). **Recommend:** expose `persistence: 'cookie' | 'localStorage+cookie' | 'memory'`
   (mode selection `posthog-persistence.ts:214-233`), default `'localStorage+cookie'`; the cookie
   half carries only the small identity/session keys for **cross-subdomain** sharing while
   localStorage holds the bulk (the split store mirrors exactly `COOKIE_PERSISTED_PROPERTIES` in
   `storage.ts:265-273`). Treat the BRIEF's "cookie default" as satisfied by the cookie-backed
   identity keys; flag the default choice to PM as a one-line decision.
2. **Cross-subdomain via config-supplied domain/scope.** The consumer supplies the cookie domain;
   the library never hardcodes one. PostHog computes it (`chooseCookieDomain` +
   `seekFirstNonPublicSubDomain`, `storage.ts:39-92`) and gates on `cross_subdomain_cookie`
   (`posthog-core.ts:234`). **Recommend:** accept an explicit `cookieDomain` from config (authoritative
   when given) with the public-suffix auto-probe as the fallback — this de-risks the eTLD detection
   (the probe sets throwaway `dmn_chk_*` cookies, `storage.ts:55-58`) and matches the BRIEF's
   "consumer supplies the domain."
3. **Anonymous id.** Generate a UUIDv7 at first load, persist it, and (PostHog-style) mark anonymity
   by `distinct_id === deviceId` + a user-state flag (`posthog-core.ts:803-817`; state constants
   `constants.ts:133-134` **[WIRE]**). **Recommend on the neutral surface:** an explicit
   `anonymous | identified` state rather than relying only on the id-equality trick — cleaner for a
   future adapter — but keep the equality encoding inside the PostHog adapter for wire compatibility.
   Make the device-id generator pluggable (PostHog: `get_device_id: (uuid)=>uuid`, `:295`).
4. **identify() merge semantics (client-side only).** Fire the anonymous→identified merge **only when
   the new id differs from the current one AND the user is still anonymous**
   (`posthog-core.ts:2552-2583`): send the merge event carrying the previous anonymous id
   (PostHog: `$identify` with `$anon_distinct_id` **[WIRE]**), set state=identified, apply
   `traits`/`traitsOnce`. **Match PostHog's guards:** re-identifying with the *same* id just updates
   traits (`:2584-2588`); an **already-identified** user identifying with a *new* id does **not**
   merge client-side (no server-side identity-merge in release 1). Signature mirrors
   `identify(id, traits, traitsOnce)` (`:2511`).
5. **Session id + expiry defaults.** Port `SessionIdManager`: **idle timeout 30 min**
   (`DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS = 30*60`, `sessionid.ts:17`; clamp bounds 1 min–10 h at
   `:18-19`), **max session length 24 h** (`SESSION_LENGTH_LIMIT_MILLISECONDS`, `:20`); ids are
   UUIDv7 (`:71-72`); a new id is minted on `noSessionId || idleTimeout || pastMaxLength`
   (`checkAndGetSessionAndWindowId`, `:371-466`). Neutral surface exposes `sessionId` + configurable
   `sessionIdleTimeout`/`sessionMaxLength`; the `$sesid` `[lastActivity, id, start]` tuple encoding
   (`cookie.ts:128-129`) is **[WIRE]**. Sessions are independent of replay (out of scope).
6. **reset() behavior.** Clear identity + persistence + session and **regenerate the anonymous id**;
   **regenerate the device id only on an explicit `resetDevice` flag** (PostHog default keeps the
   device id: `posthog-core.ts:2938-3008`, mint at `:2981-2988`, state→anonymous `:2969`). Consumer
   calls it on logout (BRIEF §1).

**Rejected alternatives.**
- *Pure-cookie default (literal BRIEF reading).* Rejected: 4 KB cap; PostHog abandoned it; use the
  localStorage+cookie split with the cookie carrying only identity/session keys.
- *Auto-detect cookie domain only (no explicit config).* Rejected: eTLD probing is fragile and the
  BRIEF says the consumer supplies the domain; auto-probe is the fallback, not the primary.
- *Server-side identity merge for identified→identified.* Rejected: out of scope; PostHog itself does
  the anon→identified merge client-side only and guards the rest.

**Confidence: high** (session defaults, reset, merge guards — directly cited) · **med** (persistence
default `localStorage+cookie` vs the BRIEF's "cookie" — a PM confirmation, not a technical unknown).

---

## E5 — Browser transport / reliability

**Neutral-seam note.** Transport *mechanics* are adapter-internal; the only neutral-surface touch is
the **config-supplied ingest host/path** and the **dedupe-id** concept. Wire specifics marked **[WIRE]**.

**Minimal port set + decisions.**
1. **Batching.** Port `request-queue.ts`. PostHog's browser batching is **purely time-based**:
   `DEFAULT_FLUSH_INTERVAL_MS = 3000`, clamped [250, 5000]
   (`posthog-js/packages/browser/src/request-queue.ts:7`, clamp `:18-24`); events grouped by
   `batchKey || url` into a `data:[]` array (`:93-108`); starts paused (`:11`). (Node/core adds a
   **count** trigger `flushAt=20` + `maxBatchSize=100`, see E7.) **Recommend:** port the time-based
   flush and add a size trigger for parity with node; expose `flushInterval`/`flushAt` in config.
   The per-event `timestamp → offset` rewrite (`:60-77`) is **[WIRE]**.
2. **Retry + backoff.** Port `retry-queue.ts`: max **10** retries (**3** for network/status-0),
   exponential `3000 * 2**n` capped at 30 min with **±50% jitter**
   (`retry-queue.ts:11,14,27,29-32`); retries only network/5xx, **never 4xx** (`:82`); uses
   `navigator.onLine` + online/offline listeners (`:53-67`); drains on unload via sendBeacon
   (`:182-196`). **Recommend:** port as-is (these are universal mechanics).
3. **Rate limiting.** Port `rate-limiter.ts`: client token-bucket (10 events/s, burst ×10 = 100;
   `:10-11,52-59`) and server-limit handling. **[WIRE]:** PostHog reads a response **body**
   `quota_limited: string[]` (not a `Retry-After` header) and blocks that batch-key for 60 s
   (`:95-108`); neutralize by having the adapter interpret whatever back-pressure signal its backend
   sends. The `$$client_ingestion_warning` event (`:9,66-74`) is **[WIRE]**.
4. **Compression.** Port `core/src/gzip.ts`: native `CompressionStream('gzip')` with fflate sync
   fallback and output validation (`gzip.ts:96-133`); browser picks gzip unless
   `disable_compression` (`posthog-core.ts:675`, default false `:299`). **[WIRE]:** the
   `compression=gzip-js` query param and `ver=`/`_=` params (`request.ts:391-418`), and the
   `Content-Type: text/plain` for gzipped bodies (`request.ts:116-123`).
5. **sendBeacon / keepalive on unload.** Port from `request.ts`: transport preference
   **fetch → XHR → sendBeacon** (`:420-455`), `keepalive` set for POSTs under ~52 KB
   (`64*1024*0.8`, `:29-35`), and `unload()` flushing both queues via sendBeacon
   (`request-queue.ts:36-49`, `retry-queue.ts:182-196`) so last/pageleave events aren't dropped.
6. **Offline queue surviving reloads — THIS IS NOT A PORT; IT'S NEW WORK.** ⚠ PostHog's retry queue
   is an **in-memory array only** — `private _queue: RetryQueueElement[] = []`
   (`retry-queue.ts:44`), nothing written to disk/localStorage. So PostHog's offline queue does
   **not** survive a reload/navigation. The BRIEF explicitly requires "offline queue (survives
   reloads)," so we must **add** a persisted queue (localStorage or IndexedDB-backed), flushed on
   next load. **Recommend:** design a persisted-queue wrapper around the ported retry logic; scope it
   into E5 explicitly. (See cross-cutting risk #1.)
7. **Per-event dedupe / insert id.** ⚠ Two distinct things in PostHog: the **idempotency key is the
   top-level `uuid`** (UUIDv7 via `getEventUuid`, `posthog-js/packages/core/src/utils/index.ts:20`;
   attached `posthog-core.ts:1366`, re-applied post-`before_send` `:1460`) — this is what node
   exposes for idempotency (`EventMessage.uuid`, E7). There is **also** a separate legacy random
   property `$insert_id`, added **only** by browser enrichment (`event-utils.ts:344` — verified
   first-hand as the sole occurrence; **absent from `core` and `node`**), which is *not* the dedup
   key. (Reconciles a conflict between the source-mapping passes: one claimed `$insert_id` "does not
   exist," the other found line 344 — both partly wrong/right; the truth is browser-enrichment-only,
   non-dedup.) **Recommend:** the neutral field is a single per-event **`dedupeId`/`insertId`**
   mapping to the wire top-level `uuid`; do not confuse it with `$insert_id`, and do not emit a random
   `$insert_id` in our de-branded port unless a target's ingestion actually dedupes on it. Settle the
   neutral name early so browser and node agree (cross-cutting).
8. **Bot filtering.** Port `core/src/utils/bot-detection.ts` — `DEFAULT_BLOCKED_UA_STRS` (~90
   substrings) + `isBlockedUA` lowercase substring match (`:3-114`), and browser's `isLikelyBot`
   (navigator.webdriver / userAgentData, `blocked-uas.ts:24-57`); suppression at capture time
   (`posthog-core.ts:1314-1321`). Consumer can extend the list; `opt_out_useragent_filter` disables.
9. **Config-supplied ingest host/path (first-party proxy).** The one clear **neutral-surface** touch:
   PostHog resolves everything off `config.api_host` via `request-router.ts` (region classification +
   `endpointFor`, `:29-122`) with analytics path `/e/`. **Recommend:** neutral config takes an
   explicit `ingestHost` (+ optional `ingestPath`) with **no** region/`i.posthog.com` defaulting
   (`request-router.ts:18,29-35` **[WIRE]**) — a bare host the consumer points at their first-party
   reverse proxy; the adapter appends its wire path internally.

**Rejected alternatives.**
- *Port PostHog's in-memory retry queue verbatim and call the offline requirement done.* Rejected:
  it does **not** survive reloads (`retry-queue.ts:44`); the BRIEF requires persistence — new work.
- *Map "insert id" to `$insert_id`.* Rejected: `$insert_id` (`event-utils.ts:344`) is not the dedup
  key; the idempotency key is the top-level `uuid`.
- *Keep region/`i.posthog.com` host defaulting.* Rejected: vendor-baked default; require an explicit
  first-party `ingestHost`, no vendor fallback.

**Confidence: high** (all numbers cited) · the offline-persistence gap is high-confidence *that it's a
gap*.

---

## E6 — Browser capture & enrichment; per-context capture profiles; autocapture

**Neutral-seam note.** The *capability* (which context to add, opt-outs) is neutral; the property
**names** (`$current_url`, `$session_entry_*`, `$prev_pageview_*`) are **[WIRE]** and normalized by
the adapter. The **per-context capture-profile** mechanism has **no posthog-js equivalent** — I
design it from engineering judgment.

**Modules to port + decisions.**
1. **Context enrichment.** Port `event-utils.ts:getEventProperties` (`:293-354`): device/browser/OS
   (`$os/$browser/$device_type/$screen_*/$viewport_*`), page (`$current_url/$host/$pathname`),
   `$referrer/$referring_domain` (`getReferrerInfo` `:194-210`, `$direct` default), `$lib/$lib_version`
   `:342-343`, `$timezone` `:323`. **UTM/campaign:** `CAMPAIGN_PARAMS` (`utm_source/medium/campaign/
   content/term` + click-ids) `:45-54`, parsed by `getCampaignParams` `:87-113`; initial variants →
   set-once (`getInitialPersonPropsFromInfo` `:256-266`). All names **[WIRE]** → de-brand to neutral
   keys (`current_url`, `browser`, `utm_source`, …).
2. **Session entry props.** Port `session-props.ts`: entry url/referrer captured once per session and
   re-prefixed `$session_entry_*` onto every event (`getSessionProps` `:106-117`, added at
   `posthog-core.ts:1552-1554`) **[WIRE]**.
3. **pageleave (time-on-page / bounce).** Port `page-view.ts` `PageViewManager`: `$pageleave` carries
   duration + scroll props (`_previousPageViewProperties` `:95-161`, duration `:157`), gated by
   `!disable_scroll_properties` (`:109`); fired on unload via sendBeacon
   (`posthog-core.ts:1093`). Toggle: `capture_pageleave` default `'if_capture_pageview'`
   (`posthog-core.ts:243`); `capture_pageview` is `boolean | 'history_change'`, default
   `'history_change'` for new configs (`:207`). **Recommend** neutral names `pageview`/`pageleave`
   with the same toggle semantics.
4. **Per-enrichment opt-out config shape.** PostHog uses a scatter of booleans/lists
   (`property_denylist: []` `:271`, `sanitize_properties: null` (deprecated → `before_send`) `:273`,
   `mask_personal_data_properties: false` `:279`, `save_campaign_params: true` `:239`,
   `save_referrer: true` `:242`, `respect_dnt: false` `:272`, `opt_out_useragent_filter: false` `:266`).
   **Recommend a single structured `enrichment` config object** with a boolean (or options) per
   context module — e.g. `enrichment: { page: true, utm: true, device: true, referrer: true,
   pageleave: true, country: {...} }` — cleaner than PostHog's flat booleans and directly expresses
   the BRIEF's "each individually opt-out-able." Country is **pluggable**: accept a consumer-injected
   `countrySource` (e.g. edge header) and a switch to disable GeoIP; the injected value is a
   **consumer-supplied value ⇒ subject to the E3 allowlist** (PostHog's GeoIP toggle is
   `$geoip_disable` **[WIRE]**).
5. **Per-context capture profiles — DESIGN (no posthog-js analogue).** The consumer defines **named
   contexts** (e.g. `"marketing"`, `"app"`), each with a **capture profile**: autocapture on/off,
   pageview auto vs manual, which enrichments, consent default. PostHog has only one global config
   per instance (nearest thing: multiple named instances, which do **not** share persistence).
   **Recommend:** a **single provider holding shared identity/session/transport**, plus a map of named
   **capture profiles** (each a partial capture-config bundle) resolved per call. The consumer selects
   the active context — `analytics.context('marketing')` returns a lightweight scoped view that
   applies the marketing profile but **delegates identity/session/transport to the shared core**, so
   cross-context funnel stitching (same distinct id, same cookie) is preserved. Config:
   `contexts: { marketing: {profile}, app: {profile} }, defaultContext: 'app'`. The library applies
   the profile; the consumer names the contexts (BRIEF). **Confidence: med** (novel; validate the
   scoped-view ergonomics with builder).
6. **Autocapture — minimal port, default OFF per BRIEF.** Port `autocapture.ts` +
   `autocapture-utils.ts`: capture-phase listeners on `document` for `submit/change/click`
   (`autocapture.ts:305-307`), element metadata via `$elements_chain`/`$el_text`/`attr__*`
   (`autocapture-utils.ts:145-258`), `ph-no-capture` skip. **[WIRE] divergence to fix:** PostHog
   **defaults autocapture ON** (`posthog-core.ts:233`) and gates via remote config
   ("enabled unless `autocapture_opt_out`", `autocapture.ts:331-351`). The BRIEF says **default off,
   opt-in per context** — so drop the remote-config gate and make it a per-context-profile flag,
   default off. Port minimally (clicks/changes/submits + elements chain); skip rageclick/dead-click/
   copy-autocapture unless a context asks.

**Rejected alternatives.**
- *One posthog-instance per context.* Rejected: PostHog instances don't share persistence, so
  distinct id/cookie/session would diverge across contexts, breaking pre-login funnel stitching.
- *Global reconfigure on route change.* Rejected: race conditions mid-navigation; loses the
  declarative named-profile model the BRIEF wants.
- *Flat per-enrichment booleans (PostHog shape).* Rejected: a structured `enrichment` object is more
  discoverable and maps 1:1 to "each individually opt-out-able."
- *Keep autocapture default-on + remote-config gate.* Rejected: BRIEF says default off; remote-config
  gating is a PostHog product coupling we don't want.

**Confidence: high** (enrichment/pageleave/autocapture ports) · **med** (capture-profile design).

---

## E7 — Node server capture

**Neutral-seam note.** The node **`AnalyticsAdapter` (server)** satisfies the same neutral SPI as
browser (E2); its batching/`/batch/` wire is adapter-internal.

**What to port + decisions.**
1. **Server client.** Port `posthog-js/packages/node/src/client.ts` (`PostHogBackendClient extends
   PostHogCoreStateless`, `:125`) and the shared queue in
   `posthog-js/packages/core/src/posthog-core-stateless.ts`. Public capture is **object-based**:
   `capture(props: EventMessage)` (`client.ts:591`) where `EventMessage = { distinctId?, event,
   properties?, groups?, timestamp?, uuid? }` (`node/src/types.ts:38-63`). The BRIEF's
   `capture(id, event, props)` is a thin neutral signature over this. Also port
   `setPersonProperties`/`groupIdentify` for **server-side trait/group updates** (BRIEF §6:
   `setTraits`/`setGroupTraits`).
2. **Batching defaults** (from core-stateless `:266-282`): `flushAt=20`, `flushInterval=10000`ms,
   `maxBatchSize=100`, `maxQueueSize=1000`; POST to `${host}/batch/` with `{api_key, batch, sent_at}`
   (`:1338-1350`) **[WIRE]**; gzip via `gzipCompress` when `!disableCompression` (`:1352-1360`); **413
   → halve `maxBatchSize` and retry** (`:1381-1388`). Oldest-dropped at `maxQueueSize` (`:1053-1056`).
3. **Idempotency via insert id.** The neutral **`dedupeId`/`insertId`** maps to `EventMessage.uuid`
   ("If provided overrides the auto-generated event UUID. Must be a valid UUID.",
   `node/src/types.ts:55-56`; core `getEventUuid` `:1163`). Same neutral field name as browser (E5) —
   no `$insert_id` on the server. Consumer passes it for idempotent retries.
4. **No-op without key.** PostHog: `disabled = options.disabled ?? false || missingApiKey`
   (`core-stateless.ts:287`). **Recommend** the same whole-stack `NoopAdapter` as E2 — unkeyed server
   client silently no-ops (queue never sends). Storage seam is in-memory only
   (`node/src/storage-memory.ts:3-13`) — no persistence server-side, correct for node.
5. **Signature parity.** Keep the neutral server capture signature aligned with the browser
   `track`/`identify` so a distinct id captured client-side and server-side stitches (BRIEF: "keyed on
   the same distinct id"). The transport seam is `fetch(url, options)` (`client.ts:393`), pluggable so
   the consumer can inject a fetch impl / first-party proxy.

**Rejected alternatives.**
- *Positional `capture(id, event, props)` internally.* Keep it as the **neutral** signature but map to
  PostHog's object `EventMessage` inside the adapter — don't re-plumb node's internals.
- *Persist the node queue.* Rejected: server processes are ephemeral/replicated; in-memory + flush on
  shutdown (30 s default, `core-stateless.ts:1512`) is correct; durability is the consumer's infra
  concern.

**Confidence: high.**

---

## E8 — Query client (durable KPI snapshotting)  **[SEAM]**

**Neutral-seam split — and a scope flag.** ⚠ **posthog-js has NO query client** — it is an
ingestion/read-flags SDK only (grep for `HogQLQuery`/`/query`/insight kinds returns zero SDK
matches). So E8 is **not a port**; it's a from-scratch adapter over PostHog's **HTTP Query API**,
which uses a *different auth and wire* than ingestion. *Adapter-internal:* the HogQL/Query API wire.
*Neutral surface:* the `AnalyticsQueryClient` interface — the library's own; must not be shaped by
HogQL.

**PostHog Query API wire (adapter-internal) — from docs (posthog-js has no code for it).**
- Endpoint `POST /api/projects/:project_id/query/`; auth `Authorization: Bearer <personal_api_key>`
  ("Query Read" scope) — a **personal API key, server-only**, NOT the ingestion write key
  (docs: https://posthog.com/docs/api/queries).
- Raw HogQL: body `{ "query": { "kind": "HogQLQuery", "query": "SELECT …" } }`
  (docs: https://posthog.com/docs/hogql).
- Structured insights discriminate on `query.kind`: `TrendsQuery` / `FunnelsQuery` / `RetentionQuery`
  (often wrapped `{ "kind": "InsightVizNode", "source": { "kind": "TrendsQuery", "series": […],
  "dateRange": {…} } }`).
- Response envelope: `{ results: any[][], columns: [], types: [], hogql, clickhouse, is_cached,
  … }`; async mode returns `{ query_status: { id, complete } }` to poll.

**Recommendation — the neutral surface.**
1. **`AnalyticsQueryClient` speaks BUSINESS primitives, not HogQL:** `funnel({steps, within,
   breakdown?})` · `retention({cohortEvent, returnEvent, periods, granularity, breakdown?})` ·
   `trend({event, aggregation, breakdown?, window})` · `uniqueCount({event, window, breakdown?})` ·
   `rawQuery(expr)` (adapter-specific escape hatch). These are the BRIEF §7 shapes and are
   **backend-neutral** — a warehouse/SQL adapter must satisfy the same interface. The first adapter
   translates each method into the matching HogQL/insight `kind` and POSTs to the Query API; a future
   SQL-over-warehouse adapter translates the same calls to SQL.
2. **Return neutral, snapshot-shaped results, not the raw HogQL envelope.** Each method returns a
   typed result a snapshot job can persist (rows + metadata), normalizing away `results/columns/types`
   vs a warehouse's row objects. The consumer owns snapshot STORAGE + KPI definitions; the library
   owns the query PRIMITIVES.
3. **`rawQuery(expr)` is the only place a vendor dialect surfaces** — explicitly the escape hatch, so
   `funnel/retention/trend/uniqueCount` stay dialect-free. The warehouse target is a **stub**: define
   the interface + a `NotImplemented`/typed-stub adapter so the shape is proven and "a new adapter is
   fill-in-the-blanks" (BRIEF deliverable 4).
4. **Auth/config surface.** Query uses a **server personal key + config-supplied query endpoint**,
   kept distinct from the ingest key/host (E5). Neutral config: `query: { endpoint, apiKey,
   projectId? }`. Personal-key handling is server-only (never ship it to the browser) — a security
   constraint to state in docs.

**Rejected alternatives.**
- *Expose HogQL/`kind` on the neutral interface.* Rejected: anchors the seam on PostHog; a warehouse
  adapter can't satisfy a HogQL-shaped interface (bar A). HogQL lives inside the first adapter only.
- *Only `rawQuery`, skip the structured methods.* Rejected: pushes vendor SQL into consumer code
  (breaks bar B) and provides no neutral funnel/retention/trend primitive.
- *Reuse the ingest write key for queries.* Rejected: the Query API needs a personal API key with
  different scope/security posture; conflating them is wrong and unsafe.

**Confidence: high** (neutral interface shape) · **med** (exact HogQL translation per method — the
structured insight-query field schemas aren't in the two cited doc pages; the first adapter will need
PostHog's query-schema reference or `WebFetch` follow-up when built).

---

## E9 — React / Next binding

**Neutral-seam note.** The binding must expose the **neutral** `AnalyticsProvider`, never a vendor
client; posthog-js's react package is the shape reference only.

**What packages/react provides + the neutral binding.**
1. **Provider.** Port the shape of `posthog-js/packages/react/src/context/PostHogProvider.tsx:42`:
   a context provider whose props are a **discriminated union** — either an already-built `client`
   **or** `config` to construct one (`:23-25`; client wins, `:52-60`). Init runs in a **`useEffect`
   (SSR-safe, not during render)** with a StrictMode double-invoke guard (`:81-136,:47`). **Neutral
   binding:** `<AnalyticsProvider client={analytics}>` or `<AnalyticsProvider config={…}>`, holding a
   neutral `AnalyticsProvider` instance in context (`PostHogContext.ts:12` is the shape reference).
2. **Hooks.** Port `usePostHog` → **`useAnalytics()`** returning the neutral client from context
   (`hooks/usePostHog.ts:4-7` is a one-liner `useContext` read). PostHog's other hooks are
   feature-flag hooks (`hooks/index.ts:1-6`) — **out of scope** (E-flags is a typed extension point,
   not implemented); ship only `useAnalytics()` (and maybe a `usePageView()` helper for router-driven
   `page()` calls, since the BRIEF stresses framework-router-safe manual pageviews).
3. **Next.** Provide the SSR-safe provider + a note that pageview capture is **manual/router-driven**
   (the provider doesn't auto-capture pageviews — PostHog's provider also doesn't, `:140`), so
   App-Router/Pages-Router consumers wire `page()` on route change.

**Rejected alternatives.**
- *Port the flag hooks now.* Rejected: flags are out of scope (typed extension point only, E2).
- *Auto-capture pageviews in the provider.* Rejected: not framework-router-safe; PostHog's provider
  doesn't either; expose a manual `page()`/`usePageView()` instead.

**Confidence: high.**

---

## E10 / E11 — Generic example consumer + docs & acceptance-bar audit

**E10 — what the example must exercise to prove bar B (config-only adoption).** An invented product
under `examples/` that supplies, via config/generics ONLY (zero product logic in the lib): a concrete
`defineTaxonomy<T>()` (its own event names + prop types); an identity mapping onto
`identify()/group()`; a `cookieDomain` + cross-subdomain scope; **named contexts + capture profiles**
(e.g. `marketing` autocapture-on/auto-pageview vs `app` autocapture-off/manual); an `allowlist`; KPI
/snapshot definitions calling `funnel/retention/trend/uniqueCount`; and framework wiring via
`@analytics-kit/react`. The BRIEF's test set is the acceptance harness and each maps to an epic:
headless no-op with no key (E2); anon→identified merge across a **simulated cross-subdomain journey**
(E4); `reset()` clears identity (E4); per-context profile applied (E6); **allowlist rejects a
disallowed key loudly** (E3); each query method returns the snapshot shape (E8). Proving these against
a mock/in-memory adapter (never a real backend) *is* bar B.

**E11 — the docs matrix + bar-A/B audit.**
- **README matrix:** each interface method → its ported implementation → the intended future
  warehouse/SQL implementation (so "a new adapter is fill-in-the-blanks"), plus an "adopt in a new
  app" config-only section (BRIEF deliverable 4).
- **Bar A audit:** demonstrate provider-swap = one new adapter, zero consumer change — swap the
  ported HTTP adapter for the null adapter (or a second mock) with **no** example-consumer edits.
- **Bar B audit:** the example adopts by config only — no library edits.
- **Vendor/product-name scan (the critical gate):** grep the library source/API/type names/file
  names/docs for `posthog` and any vendor/product/event-name/domain leakage — must be **zero** (the
  whole reason the library exists; handoff records this as an architect-reviewer *critical* check).
  Include `$`-prefixed names and `i.posthog.com`/region strings in the scan, since those are the most
  likely to slip through from ported code.

**Rejected alternatives.**
- *Ship the first real consumer in this repo.* Rejected: BRIEF says the first real consumer integrates
  in its own repo; this repo ships only the invented generic example.
- *Audit only source, not docs/type-names.* Rejected: the zero-vendor rule covers API, type names,
  package/file names, and docs — the scan must span all of them.

**Confidence: high.**

---

## E-cross — Cross-cutting risks, hidden dependencies, and the 3 biggest gaps

**The 3 biggest gaps in the plan (highest-leverage to fix now).**

1. **Offline queue survival is NEW work, not a port.** PostHog's retry queue is **in-memory only**
   (`posthog-js/packages/browser/src/retry-queue.ts:44`) and does **not** survive reloads. The BRIEF
   requires "offline queue (survives reloads)." If E5 is scoped as "port request/retry queue," it will
   silently under-deliver. **Fix:** add a persisted-queue (localStorage/IndexedDB) requirement to E5
   explicitly, flushed on next load.

2. **The query client (E8) is a from-scratch build over a different API surface.** posthog-js has no
   query code; E8 targets PostHog's **HTTP Query API** with a **personal API key** (different auth,
   server-only) and HogQL wire — none of it reusable from the SDK. Plus the neutral funnel/retention
   semantics must survive translation to *two* future backends. **Fix:** treat E8 as design+build, not
   port; budget for the HogQL translation and the personal-key security handling; the structured
   insight-query field schemas need a follow-up doc pull when the adapter is built.

3. **The browser core is one 4,200-line monolith, and E4/E5/E6 each slice the SAME file.** PostHog's
   browser SDK is a **sibling** of the shared stateless base (it does **not** extend it —
   `posthog-js/packages/browser/src/posthog-core.ts:389` `implements PostHogInterface`), so identity,
   transport, capture, and enrichment are one interdependent web in `posthog-core.ts`
   (`calculateEventProperties` `:1501-1638`, capture `:1292-1479`, identify `:2511-2598`, reset
   `:2938-3008`). E4/E5/E6 cut across it. **The real cost is de-branding and de-coupling that
   monolith into the neutral facade + adapter, not the per-feature logic.** Underestimating this is the
   biggest schedule risk. **Fix:** front-load an E4/E5/E6 shared-decomposition spike (the neutral event
   object + the property-build order) before splitting the tracks.

**Other cross-cutting risks / hidden dependencies (things the E1→E11 order gets subtly wrong).**

- **Consent has no owner.** `optOut/hasOptedOut` (E2 interface) must switch persistence to memory
  (E4), gate capture (E6), and interact with the allowlist (E3) — it's spread across four epics with
  no single owner. **Fix:** make consent a named cross-cutting concern; decide "opt-out ⇒ whole-stack
  no-op/memory" in E2 alongside the null adapter.

- **The no-op must be whole-stack, coupling E2↔E4.** "No-op when unkeyed" (E2 factory) has to also
  no-op identity/persistence/session (E4 memory mode), or an unkeyed browser client still writes
  cookies. Decide the null adapter's reach in E2 but implement the persistence half in E4.

- **The dedupe-id name must be settled before E5 and E7 diverge.** Browser (E5) and node (E7) must use
  the **same** neutral field mapping to the wire `uuid` (not `$insert_id`). Settle the neutral name in
  the E2/E3 seam so both targets agree; otherwise cross-target idempotency breaks.

- **E3's allowlist boundary must anticipate E6's consumer-injected enrichment.** The allowlist (E3,
  facade, pre-enrichment) trusts library-generated keys but must gate the **consumer-injected country
  source** that lands in E6. Design the "consumer-supplied value ⇒ gated" path in E3, not as an E6
  afterthought.

- **Groups typing threads E3↔E6↔E2.** `group()` is an event-context primitive folded into the
  identity area; ensure group typing flows through `defineTaxonomy` (E3) and the capture path (E6) and
  the SPI (E2) — don't let it fall between the identity and capture epics.

- **Session id must exist even in memory/no-op mode.** Sessions (E4) are needed by enrichment (E6) and
  transport session-props; memory mode must still mint a session id, or E6 enrichment breaks under
  consent-declined.

- **Autocapture default flips vs PostHog.** PostHog defaults autocapture ON and remote-config-gates it
  (`autocapture.ts:331-351`); the BRIEF wants default OFF per context — so the port must **remove** the
  remote-config coupling, or a de-branded autocapture will silently phone-home for gating.

**Confidence: high** on all three gaps (directly grounded) · **med** on the consent-ownership and
decomposition-spike recommendations (judgment calls for PM sequencing).

---

### Appendix — citation legend

All `posthog-js/packages/…:LINE` citations are into the local reference checkout at HEAD and describe
**PostHog's** mechanics (the thing we port from and de-brand), never the library's own shipped shape.
`[WIRE]` = PostHog-specific protocol detail that stays inside an adapter. `[SEAM]` = section touches
the vendor-neutral consumer surface, where PostHog's shape is a capability reference only and the
neutral shape is decided here against bars A/B.
