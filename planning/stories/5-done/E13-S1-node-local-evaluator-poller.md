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
  - **Rollout-hash bucketing** — the deterministic consistent-hash `SHA1(flagKey "." bucketingValue
    + salt)` → first **15** hex nibbles → int → `/ LONG_SCALE` → a `[0,1]` float (top-inclusive: an
    all-`f` slice yields exactly `1.0` — do NOT renormalize to `[0,1)`; the 100%-rollout gate depends on
    `1.0 <= 1.0`). No salt (`''`) for rollout; the literal `'variant'` salt for the variant band (the
    salt is a **suffix on `bucketingValue` with NO separator** — the `.` sits between key and value only).
    Rollout gate is inclusion `_hash <= rollout_percentage / 100.0` (exclusion is strict `>`); divide by
    `100.0` (float), never integer-divide. Port `_hash` + `LONG_SCALE` (`0xfffffffffffffff` = **15 f's** =
    `2^60 − 1` = `1152921504606846975`, kept a FLOAT divisor) + `hashSHA1` (`crypto.ts`) VERBATIM in
    algorithm — the constant, the SHA-1 concat shape, and the 15-hex-nibble slice are the load-bearing
    parity invariant (see Technical notes for the exact pinned vector). `bucketingValue` is the
    `distinctId`, or the group key for a group-aggregated flag.
  - **Property operators** — `exact`/`is_not` (case-insensitive, array membership), `is_set`/
    `is_not_set`, `icontains`/`not_icontains`, `regex`/`not_regex`, `gt`/`gte`/`lt`/`lte` (numeric
    then lexicographic), `is_date_before`/`is_date_after` (incl. relative dates like `-30d`), and the
    `semver_*` family. Default operator is `exact`. Port the `matchProperty` `switch`.
  - **Condition-group + variant matching** — OR across condition groups, AND within a group,
    rollout gate per group, contiguous variant bands (`variantLookupTable` / `getMatchingVariant`),
    and a hard `condition.variant` override. Bands are **cumulative running sums** of
    `variant.rollout_percentage / 100` in **declared array order** (do NOT sort), each band matched
    **half-open `[value_min, value_max)`** (lower inclusive, upper exclusive), first match wins; a hash
    landing in a gap (variant percentages sum < 100) returns no variant and the flag resolves to bare
    `true`. The variant hash uses the `'variant'` salt and is computed **independently** of the rollout
    hash — a flag can pass rollout on one hash and land in a band on the other, both off the same
    `bucketingValue`.
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
    query params, and the two-key auth scheme are `[WIRE]`-const internals — match the SHIPPED node
    flag adapter's convention: plain UPPER_SNAKE `*_WIRE_*` consts (e.g. `DEFINITIONS_ENDPOINT_WIRE_PATH`),
    NOT `$`-prefixed. (`$`-const naming is the browser package's property-key convention, not node's
    flag wire — `http-flag-adapter.ts` uses `FLAG_ENDPOINT_WIRE_PATH`/`TOKEN_WIRE_KEY`, plain non-`$`.)
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
- [ ] The rollout/variant hash matches the reference algorithm exactly, asserted at THREE tiers against
      the pinned vector (see Technical notes): (1) the SHA1 primitive —
      `SHA1("some-flag.some_distinct_id") == "e4ce124e800a818c63099f95fa085dc2b620e173"`; (2) the exact
      `_hash` floats (e.g. `("simple-flag","distinct_id_0") → 0.78369637642204315`,
      `("simple-flag","distinct_id_1") → 0.33970699269954008`); (3) the end-to-end consistency vector —
      `simple-flag` at 45% over `distinct_id_{0..9}` → `[false,true,true,false,true,false,false,true,false,true]`.
      A rollout at 0% never matches (except an exact-`0.0` hash), at 100% always matches (incl. the
      all-`f` `1.0` edge), and the same actor lands in the same variant band deterministically across runs.
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
      constants, and rule/cohort wire shapes confined to `*_WIRE_*`/`[WIRE]`-const internals (the
      SHIPPED node convention — plain UPPER_SNAKE, not `$`-prefixed); `pnpm neutrality-scan` green.
- [ ] Gates green: `pnpm --filter @analytics-kit/node build test typecheck lint`; all tests
      mock/loopback, never a live backend or live key.

## Technical notes

- **Reference to de-brand:** `posthog-js/packages/node/src/extensions/feature-flags/feature-flags.ts`
  (`matchProperty` + `matchFeatureFlagProperties`/`isConditionMatch`/`getMatchingVariant`/
  `variantLookupTable`, the cohort `matchPropertyGroup`, the `_hash`/`LONG_SCALE` bucketing, the two
  error classes, and the `FeatureFlagsPoller` load/reschedule path) + `crypto.ts` (`hashSHA1`). Port
  the ALGORITHM verbatim, the NAMING de-branded. — posthog-source-guide (2026-07-10).
- **The hash is the load-bearing parity invariant — do NOT "improve" it, pinned EXACTLY
  (— posthog-source-guide 2026-07-10, verified against both reference suites + re-computed):**
  reference `_hash` at `posthog-js/packages/node/src/extensions/feature-flags/feature-flags.ts:1041-1044`,
  `hashSHA1` at `.../crypto.ts:3-12`, `LONG_SCALE` at `feature-flags.ts:10`. Algorithm, verbatim:
  - **Concat:** `hashString = SHA1(`​`` `${key}.${bucketingValue}${salt}` `` ​`)` — UTF-8, lowercase hex
    digest (40 chars). The `.` separator sits **between key and bucketingValue ONLY**; `salt` is a
    **suffix appended to `bucketingValue` with NO separator**. Rollout salt = `''`; variant salt = the
    literal 7-char string `'variant'`.
  - **Slice + scale:** `parseInt(hashString.slice(0, 15), 16) / LONG_SCALE`, where
    `LONG_SCALE = 0xfffffffffffffff` (**exactly 15 f's** = `2^60 − 1` = `1152921504606846975`). Keep the
    divisor a FLOAT and do the division in float64 (the 60-bit numerator exceeds JS
    `Number.MAX_SAFE_INTEGER`, but immediate float division matches Python's `int / float(...)` — a port
    using `Decimal`/integer-division would silently drift). Range is `[0,1]` **top-inclusive** (all-`f`
    slice → exactly `1.0`); do NOT renormalize to half-open.
  - **Rollout gate:** inclusion is `_hash <= rollout_percentage / 100.0` (the reference expresses the
    exclusion `_hash > rollout/100.0` at `feature-flags.ts:633`). 0% ⇒ effectively no one; 100% ⇒
    everyone incl. the `1.0` edge. Divide by `100.0` (float), never integer-divide.
  - **Variant bands** (`variantLookupTable` `feature-flags.ts:652-668`, `getMatchingVariant` `:640-650`):
    cumulative running sums of `variant.rollout_percentage / 100` in declared array order (do NOT sort),
    matched half-open `[value_min, value_max)`, first match wins; gap ⇒ bare `true`.
  - **THE PINNED CROSS-TREE VECTOR (S1 asserts, S3 re-asserts the SAME, S4 anchors it):**
    (1) primitive — `SHA1("some-flag.some_distinct_id") == "e4ce124e800a818c63099f95fa085dc2b620e173"`
    (`posthog-js/packages/node/src/__tests__/crypto.spec.ts:5-6`);
    (2) exact floats — `("simple-flag","distinct_id_0") → 0.78369637642204315`,
    `("simple-flag","distinct_id_1") → 0.33970699269954008`,
    `("simple-flag","distinct_id_2") → 0.37204343502390519`, and variant-salt
    `("multivariate-flag","distinct_id_0") → 0.61864545379303792`;
    (3) end-to-end — `simple-flag` at 45% over `distinct_id_{0..9}` →
    `[false,true,true,false,true,false,false,true,false,true]`
    (`feature-flags.spec.ts:4038-5067`), and `multivariate-flag` (group 55%, variants 50/20/20/5/5)
    over `distinct_id_{0..}` → `['second-variant','second-variant','first-variant',false,false,'second-variant','first-variant',…]`
    (`feature-flags.spec.ts:5071-6109`). These are REAL reference-suite vectors, not invented — pin all
    three tiers so a wrong f-count, wrong slice length, or int-vs-float division fails a test.
  This must be bit-identical to whatever backend produces the remote eval or S4's ground-truth diff
  fails. The ONLY change from the reference is stripping vendor naming. This is exactly what the S3
  Python port must replicate — S3 references `posthog-python/posthog/feature_flags.py:79-82` (`_hash`),
  `:14` (`__LONG_SCALE__ = float(0xFFFFFFFFFFFFFFF)`, same 15 f's), confirmed byte-identical.
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
- **The pure evaluator is SYNCHRONOUS — do not carry the reference's `async` through
  (— posthog-source-guide 2026-07-10):** the reference `_hash`/`matchFeatureFlagProperties`/
  `getMatchingVariant` are `async` (`feature-flags.ts:1041,491,640`) ONLY because `hashSHA1` awaits
  WebCrypto's `subtle.digest`. In node, hash synchronously via node's `crypto` (`createHash('sha1')`),
  keeping the pure matcher a plain synchronous function of its inputs — no `Promise`, no `await`. This
  matters for S2: the poller owns the only async boundary (the definitions fetch); the per-flag eval S2
  calls in its resolution loop must be sync so the strategy branch stays inside the existing
  `async evaluate` without a nested await-per-flag. (AC-1's "no I/O, no timers, no HTTP" already implies
  this; stated explicitly so the builder doesn't port the `async` signature.)
- **S1→S2 evaluator API contract (coordination pin — this is the surface S2 binds to):** expose an
  adapter-internal `evaluateFlagLocally(definition, bucketingValue, personProperties, groupProperties,
  cohortMap) → FlagValue` that either RETURNS a resolved `FlagValue` (`string | boolean`) or THROWS one
  of the two inconclusive signals — plus the poller's `isReady()` + a defs-snapshot accessor. S2's
  strategy loop is `try { local } catch (InconclusiveMatchError | RequiresServerEvaluation) { fallback }`
  per flag. Keep the throw-based control flow (not a result-union) — it mirrors the reference and is what
  S2's Technical notes assume. Name the exported-internal symbols concretely here so S2 doesn't re-invent
  them.
- **Split confirmation (— posthog-source-guide 2026-07-10):** the reference's natural fault line is
  (a) pure evaluator + hashing + operators + cohorts (~55-60%, fully pure), (b) poller/cache (~30%,
  needs only a `fetch` seam), (c) resolution/fallback (~10-15%, lives in the client). This story is
  (a)+(b); S2 is (c). If (a) proves large in practice the builder MAY internally separate the pure
  matcher from the poller into two files, but it ships as one story.

> Reviewer suggestion (2026-07-10): `resolveDefinitionsUrl` (`definition-poller.ts`) sets `send_cohorts=` empty — harmless in S1 (no live backend), but if the real endpoint wants `send_cohorts=true`, wire it in S4's live path.
> Reviewer suggestion (2026-07-10): ETag/`If-None-Match` + backoff omitted (explicitly story-optional) — anticipated S1 follow-up; the required core (interval poll, immediate first load, in-flight dedup, `stop()`) is in.

## Shipped

> Captured by `implement-epics` on 2026-07-10.

- **Files added (all adapter-internal under `ts/packages/node/src/flags/local/`):** `hash.ts` (sync `hashSHA1` + `bucketHash` + `LONG_SCALE`), `errors.ts` (`InconclusiveMatchError`/`RequiresServerEvaluation`), `definition-types.ts`, `match-property.ts`, `match-cohort.ts`, `evaluator.ts`, `definition-poller.ts`, `index.ts` (subdir barrel) + 4 test files (67 tests).
- **Files changed:** none — internal-only; node `index.ts`/`node-analytics.ts`/`FrozenNodeMembers` untouched (**zero seam/port change**, the E12 regression-check invariant).
- **New public API:** none (nothing re-exported from the package index). The **S1→S2 internal surface** (from `./local`): `computeFlagLocally(definition, context, snapshot): FlagValue` (S2 binds to this — resolves the bucketing value from `FlagContext` internally, group-aggregation walled in S1), `evaluateFlagLocally(...)` (low-level), `resolveBucketingValue(...)`, and `DefinitionPoller` (`start`/`isReady`/`getSnapshot`/`stop`) + `DefinitionPollerConfig`. Matcher SYNC; poller owns the only async boundary. Both entrypoints RETURN `FlagValue` or THROW one of the two inconclusive signals.
- **Tests added:** `flags/local/{hash.test.ts(9),match-property.test.ts(26),evaluator.test.ts(22),definition-poller.test.ts(10)}`.
- **Commit:** `main` (message = story title)
- **Reviewer notes:** ship-ready, no critical, first review. Reviewer **independently recomputed the hash in a standalone node process against the `posthog-js` reference arithmetic** (not the test's expectation) and signed off all 3 tiers byte-for-byte — the verified cross-tree parity anchor for S3. Confirmed operators verbatim + non-vacuous, both inconclusive signals + both deferrals, poller dedup/stop non-vacuous, zero-seam-change (only `flags/local/` in the diff), neutrality (`*_WIRE_*` UPPER_SNAKE, non-`$`). 2 suggestions captured.
- **Scope deferrals (architect-confirmed, in-scope-as-deferred):** (1) flag-dependency chains (`type:'flag'` property) → throw `InconclusiveMatchError` at BOTH sites (condition-level `evaluator.ts` + cohort-nested `match-cohort.ts`) → S2 falls back to remote; the reference's literal no-evaluator behavior, keeps the matcher stateless. (2) `early_exit`/`out_of_rollout_bound` short-circuit dropped — strictly MORE conservative (falls back to remote in the rare inconclusive-after-rollout-exclusion case), identical terminal value on the pinned vectors. Both invisible to the pinned vectors by construction (empty-props, single-group flags).
- **Cross-story seams exposed:** **S2** — bind to `computeFlagLocally(flag, context, snapshot)` per-flag over `poller.getSnapshot().flags` inside the UNCHANGED async `evaluate`; catch BOTH `InconclusiveMatchError` and `RequiresServerEvaluation` → route that flag to E12's shipped remote `roundTrip`; the poller is the async boundary, the matcher is sync (no await-per-flag). **S3 (Python)** — must reproduce ALL 3 hash tiers byte-for-byte from `posthog-python/posthog/feature_flags.py` (`__LONG_SCALE__ = float(0xFFFFFFFFFFFFFFF)`, same 15 f's); the algorithm is `hash.ts` verbatim from the reference. **S4** — `send_cohorts` live wiring + the ETag follow-up.
