---
id: E13-S1-node-local-evaluator-poller
epic: E13-FF-local-eval
status: ready-for-dev
area: feature-flags
touches: [node]
depends_on: []
api_impact: additive
---

# E13-S1-node-local-evaluator-poller — In-process evaluator + definition poller (TS node)

## Why

Local evaluation's parity-critical core: a pure, in-process `matchProperty` evaluator (rollout-hash
bucketing + property operators + cohort/variant matching) plus a definition poller that fetches flag
**definitions** on an interval. This is the largest, most self-contained, most testable slice — and
the one whose bucketing must be bit-identical to a remote eval or local and remote disagree for the
same actor. It slots **entirely behind E12's unchanged `evaluate`** as adapter-internal machinery;
this story adds NO seam surface. Wiring it into the resolution/fallback ladder is S2.

## Scope

### In

- **A pure in-process evaluator module** (`ts/packages/node/src/flags/local/` subdir, adapter-internal
  — nothing exported from node's `index.ts` in this story) de-branded from
  `posthog-js/packages/node/src/extensions/feature-flags/feature-flags.ts`:
  - **Rollout-hash bucketing** — the deterministic consistent-hash of `flagKey "." bucketingValue`
    (no salt for rollout; the `'variant'` salt for the variant band) → a `[0,1)` float compared to
    `rollout_percentage/100`. Port `_hash` + `LONG_SCALE` (`0xfffffffffffffff`) + `hashSHA1`
    (`crypto.ts`) VERBATIM in algorithm — the constant, the SHA-1 concat shape, and the 15-hex-nibble
    slice are the load-bearing parity invariant (see Technical notes). `bucketingValue` is the
    `distinctId`, or the group key for a group-aggregated flag.
  - **Property operators** — `exact`/`is_not` (case-insensitive, array membership), `is_set`/
    `is_not_set`, `icontains`/`not_icontains`, `regex`/`not_regex`, `gt`/`gte`/`lt`/`lte` (numeric
    then lexicographic), `is_date_before`/`is_date_after` (incl. relative dates like `-30d`), and the
    `semver_*` family. Default operator is `exact`. Port the `matchProperty` `switch`.
  - **Condition-group + variant matching** — OR across condition groups, AND within a group,
    rollout gate per group, contiguous variant bands (`variantLookupTable` / `getMatchingVariant`),
    and a hard `condition.variant` override.
  - **Cohort matching** — nested AND/OR property groups against a locally-fetched cohort map.
  - **Two inconclusive signals** — an adapter-internal `InconclusiveMatchError` analog ("have the
    definition, can't decide with the properties given": missing person property, experience
    continuity, bad regex/date/semver, missing/circular flag dependency) and a distinct
    `RequiresServerEvaluation` analog ("definition references server-only data": a cohort referenced
    by a filter not present in the local cohort map — a static cohort). Both are **thrown out of the
    evaluator** and left UNHANDLED by this story (S2 catches them to drive the fallback ladder);
    inconclusive-in-one-group must NOT poison other OR groups. Neutral names — no vendor token in the
    class name or message.
- **A definition poller** (same subdir) de-branded from the `FeatureFlagsPoller` path:
  - Fetch flag **definitions** (not evaluated flags) — the definition list + group-type mapping +
    cohort map — from a **config-supplied definitions endpoint**, authenticated by the
    **privileged (definition-reading) credential** (see the credential note). Endpoint path,
    query params, and the two-key auth scheme are `$`-const/`[WIRE]` internals.
  - A **self-rescheduling `setTimeout`** poll (immediate first load, then reschedule at a
    config-supplied interval BEFORE doing work — mirror the reference's `_loadFeatureFlags`), in-flight
    **dedup via a single shared promise**, and a **`stop()`** that clears the timer. ETag/`If-None-Match`
    conditional requests + backoff-on-error are **nice-to-have, not required** in this story (note them
    for a follow-up if omitted); the required core is: interval poll, immediate first load, dedup, stop.
  - Store the parsed definitions in memory; expose an adapter-internal `isReady()` / snapshot-of-defs
    accessor S2 reads. A `fetch` injectable (mirror the remote adapter's `FetchLike`) so tests never
    hit a live backend.
- **Tests** — exhaustive, all mock/loopback (no live backend, no live key): the hash produces a stable
  known-vector float for a fixed `(flagKey, distinctId)`; every operator matches/rejects correctly;
  rollout gate at boundary percentages; variant band selection; cohort AND/OR; the two inconclusive
  signals throw for the right inputs and are distinguishable; the poller loads on first tick,
  reschedules, dedupes concurrent loads, and `stop()` halts it (assert with fake timers).

### Out

- **Local/remote resolution + fallback wiring** (`onlyEvaluateLocally`/`strictLocalEvaluation` config,
  catch-inconclusive-then-remote, the per-flag merge, wiring into `HttpFlagAdapter.evaluate`) — **S2**.
  This story leaves the evaluator + poller as standalone adapter-internal machinery; nothing calls them
  from `evaluate` yet.
- **Python analog** — S3.
- **Ground-truth parity proof against a real remote eval** — S4 (needs the privileged key).
- **Any seam / port / `FlagContext` / `FlagSet` change** — E12 owns those; touching them means E12 was
  wrong. This is pure adapter-internal code.
- **ETag/backoff hardening** — desirable but explicitly optional here (see In); if omitted, note as a
  follow-up. Do not let it grow the story.

## Acceptance criteria

<Ground in the two bars: this story proves the machinery exists behind the unchanged port; S2 proves
the strategy is invisible; both together prove bar A/B for local eval.>

- [ ] The evaluator is a pure function of `(flag definition, bucketingValue, person/group properties,
      cohort map)` — no I/O, no timers, no HTTP, no reads off `FlagContext` beyond what S2 passes in.
- [ ] The rollout/variant hash matches the reference algorithm exactly: a fixed `(flagKey, distinctId)`
      produces a stable float asserted against a known vector; a rollout at 0% never matches, at 100%
      always matches, and the same actor lands in the same variant band deterministically across runs.
- [ ] Every ported operator has a passing + a failing test case; the default operator is `exact`;
      `is_not_set` resolves locally for an absent key (does not throw), while a genuinely-missing
      property under a value operator throws the inconclusive signal.
- [ ] The two inconclusive signals are distinct types with neutral names/messages (no vendor token);
      `RequiresServerEvaluation` (static-cohort) is distinguishable from `InconclusiveMatchError`
      (missing-property / continuity / bad-matcher). Both propagate OUT of the evaluator unhandled.
- [ ] The poller loads definitions on the first tick, reschedules at the configured interval,
      dedupes concurrent loads to one in-flight request, and `stop()` clears the timer (asserted with
      fake timers, never a real sleep). Definitions come from a config-supplied endpoint + privileged
      credential; the fetch is injectable and mocked.
- [ ] Neutrality: `grep -ri posthog ts/packages/node/src` clean (save the architect-locked
      `// De-branded from …` provenance comments); the definitions endpoint, query params, hash
      constants, and rule/cohort wire shapes confined to `$`-const/`[WIRE]` internals;
      `pnpm neutrality-scan` green.
- [ ] Gates green: `pnpm --filter @analytics-kit/node build test typecheck lint`; all tests
      mock/loopback, never a live backend or live key.

## Technical notes

- **Reference to de-brand:** `posthog-js/packages/node/src/extensions/feature-flags/feature-flags.ts`
  (`matchProperty` + `matchFeatureFlagProperties`/`isConditionMatch`/`getMatchingVariant`/
  `variantLookupTable`, the cohort `matchPropertyGroup`, the `_hash`/`LONG_SCALE` bucketing, the two
  error classes, and the `FeatureFlagsPoller` load/reschedule path) + `crypto.ts` (`hashSHA1`). Port
  the ALGORITHM verbatim, the NAMING de-branded. — posthog-source-guide (2026-07-10).
- **The hash is the load-bearing parity invariant — do NOT "improve" it (— posthog-source-guide
  2026-07-10):** `SHA1(flagKey "." bucketingValue [+ salt])`, take the first 15 hex nibbles → int →
  divide by `LONG_SCALE = 0xfffffffffffffff` → a `[0,1)` float; rollout uses no salt, variants use the
  `'variant'` salt. This must be bit-identical to whatever backend produces the remote eval or S4's
  ground-truth diff fails. Keep the constant, the concat order, and the nibble slice exact; the ONLY
  change is stripping vendor naming. This slice is what the S3 Python port must replicate exactly.
- **Two-tier inconclusive is universal, keep both (— posthog-source-guide 2026-07-10):** the
  `Inconclusive` (retry-remote-if-allowed) vs `RequiresServerEvaluation` (static cohort — definition
  references server-only data) distinction is real and drives different S2 behavior. An inconclusive in
  one OR group must let the other groups try; only if none match AND it was inconclusive does the
  evaluator throw. Do not collapse the two into one error.
- **Definitions need the privileged credential (— posthog-source-guide 2026-07-10):** the definition
  fetch is authorized by a config-supplied **definition-reading** credential distinct from the ingest
  write key and the remote-eval project key — named by ROLE, never by any vendor key name (no
  `personalApiKey`, no `phc_`/`phx_` prefix logic on the neutral surface). The two-key scheme is
  `[WIRE]`/adapter-internal. This credential gates S4's real-stack proof, NOT this story's tests.
- **This is where S1 lives structurally:** a new `flags/local/` subdir under
  `ts/packages/node/src/flags/`, sibling to the shipped `http-flag-adapter.ts`. Nothing here is
  exported from node's `index.ts` — it's internal machinery the S2 adapter-branch consumes. The
  frozen `FeatureFlagPort`/`FlagSet`/`FlagContext` are untouched.
- **E13's load-bearing invariant:** ZERO seam/port change. If porting the evaluator/poller seems to
  need a new `FlagContext` field or a new port method, STOP — E12's port shape was wrong and that's an
  epic-level escalation, not a story decision. The reference already carries person/group properties on
  its context exactly as E12's `FlagContext` does (`personProperties`/`groupProperties`), so the
  evaluator reads what it needs off the context S2 passes in. — architect (2026-07-10, epic Notes).
- **Split confirmation (— posthog-source-guide 2026-07-10):** the reference's natural fault line is
  (a) pure evaluator + hashing + operators + cohorts (~55-60%, fully pure), (b) poller/cache (~30%,
  needs only a `fetch` seam), (c) resolution/fallback (~10-15%, lives in the client). This story is
  (a)+(b); S2 is (c). If (a) proves large in practice the builder MAY internally separate the pure
  matcher from the poller into two files, but it ships as one story.

## Shipped

<!-- Empty at draft. /implement-epics fills this when the story moves to stories/5-done/. -->
