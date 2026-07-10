---
id: E12-FF-flag-substrate-remote-eval
status: done
area: feature-flags
touches: [core, browser, node, react]
api_impact: additive
blocked_by: []
updated: 2026-07-10
---

# E12-FF-flag-substrate-remote-eval — Feature-flag substrate + remote evaluation (both trees)

## Why

Feature flags are the broadest capability every mature analytics SDK exposes and the first of the
two declared-but-unimplemented ports the seam left as stubs (`FeatureFlagPort` — TS
`ts/packages/analytics-kit/src/ports.ts:4`, Python `python/src/analytics_kit/ports.py:13`, both
`flags?`/`None`-default on the provider). In the `posthog-js` reference this capability lives across
`core` + `browser` + `node`, so it is inherently server- **and** browser-shaped and advances the TS
**and** Python surfaces together. This epic finishes the port additively for the majority of
consumers: the neutral surface, the config-supplied bootstrap, and both **remote-evaluation** adapters
(browser fetch + server round-trip) across both trees. Local (in-process) evaluation is the
server-shaped specialization split out to **E13** behind the same, unchanged neutral method — the
proof this port shape is right. Architect-consulted against the `posthog-js` checkout (2026-07-10).

## Success criteria

- The neutral `FeatureFlagPort` is finished on the seam as an **async-first snapshot model**: one
  load-bearing method `evaluate(context?): Promise<FlagSet>` returning an immutable `FlagSet` snapshot
  read synchronously via `isEnabled(key)` / `getFlag(key)` / `getPayload(key)` / `getAll()`, plus an
  `onChange(listener): () => void` change-listener. The async boundary is the load-bearing neutrality
  call — a browser first-load, a server round-trip, and a future self-hosted HTTP adapter are all
  honest behind it (a sync browser-shaped read would break parity + bar A). Zero vendor vocabulary on
  the port.
- The `FlagSet` snapshot carries a **neutral degradation signal** so a consumer can distinguish "flag
  is off" from "evaluation failed / was partial" — a snapshot-level `degraded: boolean` (and/or a
  neutral `reason(key)` read). Without it, an eval error collapses silently into a `false`/`undefined`
  read, and the consumer can't tell a real "off" from a failed round-trip. The vendor-specific
  eval-quality metadata that motivates this (`errorsWhileComputing` / `quotaLimited` / `requestId` /
  per-flag `reason` / `locallyEvaluated` on PostHog's `FeatureFlagEvaluations`) stays **behind the
  adapter**; only the neutral degraded/reason signal reaches the port. — architect (2026-07-10).
- **`FlagContext`** is the one neutral evaluation input: `{ distinctId?, groups?, personProperties?,
  groupProperties?, flagKeys? }`. `distinctId` is **required on the server adapter** (no ambient
  actor — validated by the adapter) and **optional on the browser adapter** (filled from current
  identity). Local-vs-remote evaluation strategy is **entirely adapter-internal** — never a port
  parameter — so a self-hosted adapter with only-remote or only-local eval still satisfies the one
  method (bar A).
- **Bootstrap is config-only** (`AnalyticsConfig.flags?.bootstrap?: { flags?, payloads? }`), seeded
  synchronously at init to kill the flash-of-wrong-variant; neutral field names (`flags`/`payloads`,
  never `featureFlags`/`featureFlagPayloads`). A new app supplies bootstrap by config alone, zero
  library change (**bar B**).
- The taxonomy gains a **`flags` slot** (`Record<string, FlagDecl>` where
  `FlagDecl = { variants?: readonly string[]; payload?: PropDecl }`); `getPayload(key)` and
  `getFlag(key)` narrow against it. `FeatureFlagPort<TX>` becomes generic over the taxonomy shape with
  a `DefaultTaxonomyShape` default (additive — untyped consumers unaffected, mirroring
  `AnalyticsProvider<TX>`). Python mirrors via the PY3 runtime-registry + best-effort-static pattern.
- The **browser adapter** implements remote eval: fetch the flag set at init + `reload`, cache it,
  bootstrap-seed it, fire `onChange` on async arrival. The **node/server adapter** implements the
  remote-eval path (`evaluate` → round-trip). **Python's server adapter** implements the same remote
  path at parity. All three satisfy the ONE neutral `FeatureFlagPort` — **bar A: provider-swap = one
  adapter, zero consumer change.**
- The React binding (`@analytics-kit/react`) exposes the flag surface through a hook built on
  `onChange` (browser flags arrive async), taxonomy-typed through `TX`.
- Zero vendor references on any surface: the `/flags` endpoint, the `$feature/*` wire shapes,
  bootstrap wire naming, and cache keys are `[WIRE]`, adapter-internal (`$`-const in TS, `_WIRE_*` in
  Python). `hogql` is not involved here.

## Stories

All six stories shipped (`stories/5-done/`). **S1 pinned the port ONCE across both trees**; the three
remote adapters (S2 browser, S3 node, S4 Python) built against that frozen contract; S5 layered the
React hook; S6 re-converged both trees at the example-consumer bar proofs.

- **[E12-S1](../stories/5-done/E12-S1-neutral-flag-port-taxonomy-slot.md)** *(done — `31413f4`)* — pinned `FeatureFlagPort<TX>` / `FlagSet` / `FlagContext` / the taxonomy `flags` slot / the `flags.bootstrap` config + the canonical `emptyFlagSet()` simultaneously in both `ports`+`taxonomy`+`config` files (TS + Python). The shape-defining substrate; no adapter work.
- **[E12-S2](../stories/5-done/E12-S2-browser-remote-eval-adapter.md)** *(done — `ec1024c`, 1 retry)* — browser remote-eval adapter via the `provider.flags` slot: fetch + cache + synchronous bootstrap seeding + `onChange`; `getDistinctId()` identity; de-branded from `posthog-featureflags.ts`. (Retry fixed a forced-`refresh` context-drop.)
- **[E12-S3](../stories/5-done/E12-S3-node-remote-eval-adapter.md)** *(done — `4853d01`)* — node standalone `createFlagClient` factory (NOT a `NodeAnalytics` slot — `FrozenNodeMembers` is frozen; mirrors `createQueryClient`); `distinctId` required + validated pre-network; `onChange` fires-once; per-call fetch; de-branded from node's `evaluateFlags` remote path.
- **[E12-S4](../stories/5-done/E12-S4-python-server-remote-eval-adapter.md)** *(done — `5b3709e`, 1 retry)* — Python server remote-eval adapter at parity: `Analytics.flags` slot + standalone `create_flag_client` factory; sync `evaluate`; `urllib`-HTTPError→degrade; de-branded from `posthog-python`. (Retry fixed a test daemon-thread leak.)
- **[E12-S5](../stories/5-done/E12-S5-react-flag-hook.md)** *(done — `aa57b01`)* — taxonomy-typed `useFeatureFlags<TX>()` (single snapshot hook, `onChange`-driven re-render, `NOT_IN_PROVIDER` sentinel, `emptyFlagSet()` graceful fallback). First-paint caveat accepted (async-only port); S1 sync-getter noted as a follow-up.
- **[E12-S6](../stories/5-done/E12-S6-example-consumer-flag-proof.md)** *(done — `df22456`)* — Fernly (TS) + Quillstream (Python) exercise flags by config alone; bar-A swap to a mock adapter with zero consumer change; bar-B config-only; the `FrozenFlagMembers` capability-presence pin. Zero library-src edits (audit-not-patch). The both-trees re-convergence point.

**Dependency graph:** `S1 → {S2, S3, S4}` (all three adapters build against the frozen S1 port, in
parallel); `S1 + S2 → S5` (the React hook exercises the browser adapter); `{S2, S3, S4, S5} → S6`
(the example proof re-converges both trees). No development prerequisite for E12 remote eval — the
bars are provable against a mock/in-memory flag adapter (E13/E14 carry the real-key prerequisites).

## Out of scope

- **Local (in-process) evaluation** — definition polling + `matchProperty` cohort/rollout/hashing,
  `onlyEvaluateLocally`/`strictLocalEvaluation` adapter config — the server-shaped specialization,
  **E13**. It slots in behind THIS epic's unchanged `evaluate` method; if E13 needs a seam change, the
  E12 port shape was wrong.
- **`$feature_flag_called` auto-capture** and the `capture(..., { flags })` coupling (reading a flag
  emits an analytics event / attaches flag context to other events). Real reference surface but it
  couples flags to the capture pipeline and carries `$feature/*` event shapes — a deliberate scope
  call, deferred. See Open questions.
- **Stateful flag-eval-input setters** (`setPersonPropertiesForFlags` / `setGroupPropertiesForFlags`
  — browser mutators that stash props then trigger a reload). The neutral shape carries
  person/group properties **per-`evaluate`** in `FlagContext`, which is the cleaner, honest form —
  these stateful setters must NOT enter the seam. Deferred, declared-not-omitted.
- **Client-side test overrides** (`overrideFeatureFlags`), **encrypted remote-config payloads**
  (`getRemoteConfigPayload`), **early-access-feature enrollment** (`updateEarlyAccessFeatureEnrollment`)
  — PostHog-product-specific surface, not neutral primitives. Deferred, declared-not-omitted.
- **Vendor eval telemetry** (`$feature_flag_request_id` / `requestId` and the other
  `errorsWhileComputing`/`quotaLimited`/per-flag `reason` fields on PostHog's snapshot) stays
  **adapter-internal** — only the neutral `degraded`/`reason` signal (see Success criteria) reaches the
  `FlagSet`. The raw vendor telemetry never surfaces on the port.
- **Session replay** — the other NOW capability, **E14** (browser-only, TS-only).

## Notes

Every load-bearing decision below is architect-locked (2026-07-10, re-validated at epic-refine) so
stories don't re-litigate it.

### `onChange` on a stateless server snapshot (closed — med-high confidence)

- **`onChange` stays on the port and "fires once with the resolved set" on server.** The browser
  listener genuinely re-fires on reload (PostHog's `onFeatureFlags`); a stateless server client has no
  push-based flag stream — flags are pull-per-`evaluate`, so the server contract is the *degenerate
  case* of the same signature: it fires once on the resolved snapshot, then never again. **Rejected:
  making `onChange` a browser-primary method server adapters omit** — an optional-method port weakens
  the seam and breaks bar-A uniformity (consumer code would have to branch on whether the method
  exists). Same signature, different cardinality — honest and uniform. Document the once-semantics as
  an adapter property. — architect (2026-07-10). *S1 still confirms the once-fire ergonomics read well
  against a real Python consumer, but the port shape is locked: `onChange` stays, uniform across
  adapters.*

### The async-first snapshot model (the load-bearing neutrality call)

- **`posthog-js`'s browser flag read is SYNCHRONOUS (cached in persistence after an init fetch); node's
  is ASYNCHRONOUS (`await evaluateFlags`).** Copying the browser's sync shape into the neutral port
  breaks Python (server-shaped — no persistence, no init-time fetch) and breaks bar A the moment a
  self-hosted adapter needs a network round-trip. **The neutral read surface is async at the boundary,
  sync off the snapshot.** — architect (2026-07-10): this is the single biggest trap in the area and
  it is a seam decision the PM owns, not a PostHog question.
- **PostHog itself converged on the snapshot model.** Node's per-key `getFeatureFlag`/`isFeatureEnabled`/
  `getAllFlags` are all now `@deprecated` in favor of `evaluateFlags(distinctId, …)` →
  `FeatureFlagEvaluations` snapshot with sync `isEnabled`/`getFlag`/`getFlagPayload` (checkout:
  `packages/node/src/client.ts:1204,1274,1463`; `feature-flag-evaluations.ts`). Strong SOTA signal —
  the neutral port adopts "evaluate once into an immutable snapshot, read synchronously off it."
- **v1 port surface (method-by-method, architect-recommended):** `evaluate(context?):
  Promise<FlagSet>` (the one load-bearing method); on the `FlagSet` snapshot — `isEnabled(key):
  boolean`, `getFlag(key): FlagValue | undefined` (variant string / boolean / undefined),
  `getPayload(key)` (taxonomy-typed, see below), `getAll(): Record<string, FlagValue>`, plus the
  **neutral degradation signal** (`degraded: boolean` and/or `reason(key)`); on the port —
  `onChange(listener): () => void`. **Simplification taken:** fold `reload` into `evaluate({ refresh?:
  boolean })` so the port is one async method + a listener + a read-only snapshot type — smaller
  neutral surface, easier parity + bar A. Keep `reload` separate only if the browser adapter wants a
  fire-and-forget refresh that returns nothing (decide at S2 refine).
- **The `evaluate`-single-method shape + async-first snapshot is architect-validated as the SOTA shape
  (2026-07-10, re-confirmed at epic-refine):** it is the neutralized form of PostHog's own
  convergence — node's `FeatureFlagEvaluations` is a snapshot returned once from
  `evaluateFlags(distinctId, options)`, read synchronously, with per-key reads deprecated in favor of
  the batch snapshot. The one hole in a naive copy is that the snapshot silently swallows eval-quality
  metadata — closed by the neutral degradation signal above.

### Local-vs-remote eval placement

- **Local-vs-remote is adapter-internal behind ONE neutral method — NEVER surfaced on the port.** The
  consumer asks the same question either way ("given this actor + properties, what are the flags?");
  *where* it's answered is an adapter strategy, exactly like the query client hides HTTP-vs-warehouse
  behind one `funnel()`. Surfacing `onlyEvaluateLocally` would leak a PostHog optimization into the
  neutral contract AND break bar A for a self-hosted adapter with only one eval mode. —
  architect (2026-07-10). `onlyEvaluateLocally`/`strictLocalEvaluation`/poll-interval/definition-cache
  are all **adapter config** (bar B), read by the node/Python adapter, ignored by the browser adapter.
- **`FlagContext` is the neutral evaluation input** — `{ distinctId?, groups?, personProperties?,
  groupProperties?, flagKeys? }`. `distinctId` **required on server** (validated by the adapter, no
  ambient actor — mirrors node `evaluateFlags(distinctId, …)`), **optional on browser** (adapter fills
  from current identity; person/group props come from the browser's own mechanism). This asymmetry is
  the *honest* neutral shape — do NOT invent a fake ambient server actor to force identical signatures
  (that's uniform-at-the-cost-of-honesty). Same interface, different required-ness enforced by the
  adapter — exactly how E4 handled `sessionId` (browser stamps it, node leaves it unset). —
  architect (2026-07-10).

### Bootstrap = config, not a port method

- **Bootstrap is server-rendered data handed to the client at construction — a config field, not a
  method** (making it a method inverts the timing; the point is it's available synchronously at init
  before any method could run). Neutral shape: `AnalyticsConfig.flags?.bootstrap?: { flags?:
  Record<string, FlagValue>; payloads?: Record<string, unknown> }` — neutral field names, strip
  PostHog's `featureFlag*` prefix. The adapter maps it into its backend's seeding (`initialize()` in
  the browser reference, `posthog-featureflags.ts:339`). Satisfies bar B exactly. **Parity:** bootstrap
  is browser-*primary* (kills a first-paint flash that only exists client-side) but the config field is
  neutral and Python accepts it too (SSR request-scoped eval) — advances BOTH trees; NOT Python-N/A. —
  architect (2026-07-10).

### Taxonomy `flags` slot + payload typing

- **PostHog has no compile-time taxonomy — payloads are untyped `JsonType`.** `defineTaxonomy` is a
  library-original capability, so this is a pure engineering-judgment shape (verified against
  `ts/packages/analytics-kit/src/taxonomy.ts`: `PropType`/`PropDecl`/`PropsOf` machinery, slots
  `events`/`traits`/`groups`/`page`). Add a fourth slot: `flags?: Record<string, FlagDecl>` where
  `FlagDecl = { variants?: readonly string[]; payload?: PropDecl }`. `getPayload(key)` returns
  `PropsOf<TX['flags'][key]['payload']>`; `getFlag(key)` narrows to
  `TX['flags'][key]['variants'][number] | boolean` when variants are declared. Reuses `PropsOf` /
  `TagToType` verbatim. — architect (2026-07-10).
- **Carry the taxonomy type through the port generically:** `flags?: FeatureFlagPort<TX>` (additive
  generic with `DefaultTaxonomyShape` default — the shipped `AnalyticsProvider<TX = DefaultTaxonomyShape>`
  pattern; untyped consumers unaffected). Python mirrors via the PY3 runtime-registry + best-effort
  static pattern (a `flags` registry entry, boundary-validated, statically hinted where the checker
  follows) — the same "not the TS compile-time literal guarantee" ceiling PY3 locked.
- **Payload nesting ceiling (flat for v1).** `PropDecl` is flat (`string|number|boolean|date`); flag
  payloads are often nested JSON. v1 types payloads as `PropDecl` and accepts nested-⇒`unknown` (the
  same pragmatic ceiling `PropsOf` already has). Do NOT build a recursive JSON-schema `PropType` in v1
  — note it as a hardening follow-up. See Open questions.

### Parity — both trees advance (confirmed)

- **Feature-flags is a genuine both-trees capability, NOT browser-only-with-a-Python-N/A.** Flags live
  in `core` (shared primitives) + `browser` (remote fetch/cache) + `node` (local + remote eval); the
  **server** half is the *richer* one (local eval, definition polling, the `evaluateFlags` snapshot
  PostHog steers everyone toward). Python de-brands from `posthog-python` (the server analog). The only
  asymmetry: **local eval is server-shaped** (Python-central + TS-node; absent from browser) — the
  inverse of session-replay's browser-only asymmetry, and exactly why the ROADMAP sequences flags
  first as the broadest surface. — architect (2026-07-10). Remote eval, bootstrap-as-config, the
  taxonomy slot, and `onChange` all advance BOTH trees in THIS epic; local eval is E13.

### Coordination boundary

- **The neutral port + types are decided ONCE, in S1, in BOTH `ports` files simultaneously, before any
  adapter work.** This is the one place the trees must agree exactly; everything downstream is per-tree
  adapter implementation against a frozen contract, re-converging only at the S6 audit/parity matrix.
  **Do NOT split this epic by language** (a TS epic + a Python epic) — that lets the TS port drift ahead
  of Python and reintroduces the divergence the seam exists to prevent. Split by capability/eval-strategy
  (remote here, local in E13); keep both trees inside each epic. — architect (2026-07-10).

### Open questions (all closed at epic-refine — kept as decision record)

- **`onChange` semantics on a server snapshot — CLOSED** (med-high). Locked above: stays on the port,
  fires once with the resolved set on server. See "`onChange` on a stateless server snapshot."
- **`$feature_flag_called` auto-capture — CLOSED, confirmed OUT of v1** (high). It is the single
  biggest PostHog-leak risk in this epic: node's snapshot `_recordAccess` fires `$feature_flag_called`
  carrying `$feature/*`, `$feature_flag_response`, `$active_feature_flags`, `$feature_flag_request_id`
  — all `$`-prefixed vendor shapes — and it couples flag reads to the capture pipeline. Pulling it into
  v1 would either leak those shapes onto the neutral seam or force an unscoped normalization layer.
  Confirmed deferred (see Out of scope + Expansion path forward-pointer). — architect (2026-07-10).
- **Flag-payload nesting depth — CLOSED, flat for v1** (med-high). `PropDecl` stays flat; nested
  payloads type as `unknown` (the same ceiling `PropsOf` already has, so this is consistent, not a
  special case). PostHog itself types `getFlagPayload` as loose `JsonType | undefined`, so a recursive
  JSON-schema `PropType` is real complexity with no reference driver. **Rejected** the recursive
  `PropType` for v1; noted as a taxonomy hardening follow-up orthogonal to the FF port. —
  architect (2026-07-10).

## Expansion path

- **E13 (local eval) proves the port shape.** It slots definition-polling + in-process evaluation
  entirely behind the already-shipped `evaluate` method with ZERO seam change. If E13 touches the port,
  E12 was wrong — that's the regression check.
- A future self-hosted or non-vendor flag backend is **one new adapter, zero consumer change** — it
  satisfies `FeatureFlagPort` and maps `FlagContext`/`FlagSet` to its own wire. The async-first boundary
  is what makes an HTTP-only self-hosted adapter honest here.
- Deferred surface (flag-exposure auto-capture, stateful flag-input setters, client-side overrides,
  remote-config payloads, early-access enrollment) extends additively behind the same port later, if a
  consumer need lands. **When flag-exposure auto-capture is added, exposure events emit through the
  neutral capture surface with neutral property names — the `$feature/*` / `$feature_flag_called`
  shapes stay behind the adapter** (never a `$`-shape on the neutral seam).
