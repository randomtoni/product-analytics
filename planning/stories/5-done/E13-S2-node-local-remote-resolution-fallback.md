---
id: E13-S2-node-local-remote-resolution-fallback
epic: E13-FF-local-eval
status: ready-for-dev
area: feature-flags
touches: [node]
depends_on: [E13-S1]
api_impact: additive
---

# E13-S2-node-local-remote-resolution-fallback — Local/remote resolution + fallback (TS node)

## Why

Wire S1's evaluator + poller into the node adapter as a **strategy branch behind the unchanged
`evaluate` method**: try local eval first, fall back to E12's shipped remote round-trip when a flag
can't be resolved locally, and gate that with `onlyEvaluateLocally`/`strictLocalEvaluation` **adapter
config** (never neutral port parameters). The result must be **indistinguishable** from a pure remote
eval — same `FlagSet`, same `degraded`/`reason` signal. This is the story that proves E12's port shape
holds: local vs remote is entirely adapter-internal.

## Scope

### In

- **Local-vs-remote resolution inside `HttpFlagAdapter.evaluate`** (`ts/packages/node/src/flags/
  http-flag-adapter.ts` + the S1 `flags/local/` machinery) — a strategy branch, NOT a rewrite of the
  remote path:
  - When the adapter is configured for local eval (a definitions endpoint + privileged credential is
    present and the S1 poller has loaded definitions), evaluate each requested flag **locally first**
    against the `FlagContext`'s `personProperties`/`groupProperties`/`groups`/`distinctId`.
  - On the S1 `InconclusiveMatchError`/`RequiresServerEvaluation` signal for a flag, **fall back to
    E12's existing private `roundTrip(context)` path** (`http-flag-adapter.ts:160`) for the unresolved
    flags — reuse the SHIPPED remote machinery, do NOT fork a second remote client. Because `roundTrip`
    is `private`, the branch lives INSIDE `HttpFlagAdapter` (it already does — this is a method change,
    not a new class). Merge on the `Snapshot` maps (see the merge Technical note), locally-resolved flags
    kept, remote layered over the still-unresolved ones — a single coherent snapshot.
  - Assemble the merged result into a `FlagSet` via the EXISTING `buildFlagSet<TX>(snapshot: Snapshot)`
    (`http-flag-adapter.ts:77`) with the EXISTING `FlagReason` union
    (`resolved`/`bootstrap`/`stale`/`unresolved`) — no new reason, no new field, no per-flag reason
    (the `Snapshot.reason` stays snapshot-uniform).
  - **`evaluate`'s signature is UNCHANGED** — it currently takes only `context?` (the shipped adapter
    does not read `options`, `http-flag-adapter.ts:114`); the strategy branch is added inside the body,
    the parameter list and the `Promise<FlagSet<TX>>` return are untouched.
- **`onlyEvaluateLocally` / `strictLocalEvaluation` as adapter config** — added to `FlagClientConfig`
  (`ts/packages/node/src/flags/config.ts`) + threaded into the adapter, NEVER onto the neutral
  `FlagContext`/`FlagEvaluateOptions`/`FeatureFlagPort`:
  - `strictLocalEvaluation` (client-level) makes local-only the default; `onlyEvaluateLocally`
    suppresses the remote fallback — an inconclusive flag under local-only resolves to its degraded
    neutral state (`unresolved`) rather than round-tripping. Resolve the effective value the same way
    the reference does (`onlyEvaluateLocally ?? strictLocalEvaluation ?? false`).
  - Poll interval + the definitions endpoint + the privileged credential are ALSO adapter config
    fields (surfaced through `FlagClientConfig`), read by the factory, never neutral port parameters.
- **Factory wiring** (`ts/packages/node/src/flags/create-flag-client.ts`) — when the config supplies a
  definitions endpoint + privileged credential, construct the adapter with the S1 poller/evaluator
  enabled (local-capable); otherwise the adapter stays remote-only exactly as E12 shipped. Unkeyed ⇒
  still the `FlagNoop`. Config-only selection (bar B): enabling local eval is a config change, zero
  library change. The `onChange` once-fire + `distinctId`-required contract is UNCHANGED — local eval
  is behind the same `evaluate`, so `distinctId` is still required and validated pre-eval.
- **Poller lifecycle on the adapter** — start the S1 poller when local-capable; expose a way to stop it
  (fold into the adapter's existing teardown surface if one exists, else document the poller `stop()`
  as internally managed). No leaked timers in tests (the E12-S4 daemon-thread-leak lesson's TS analog:
  fake timers or an explicit stop in test teardown).
- **Tests** — all mock/loopback (no live backend, no live key): local-first resolves a flag without a
  round-trip (assert the remote fetch was NOT called); an inconclusive flag falls back to remote
  (assert the round-trip WAS called for it) and the merged `FlagSet` carries both; `onlyEvaluateLocally`
  suppresses the fallback (inconclusive ⇒ `unresolved`, no round-trip); `strictLocalEvaluation` sets
  the default; a locally-resolved flag and a remotely-resolved flag are **indistinguishable** on the
  snapshot (same `degraded`/`reason` semantics — a local failure reads identically to a remote
  failure); `distinctId`-required still throws pre-eval; `onChange` still fires once.

### Out

- **The evaluator + poller machinery itself** — S1 (this story consumes it).
- **Python analog** — S3.
- **Ground-truth parity proof against a real remote eval** — S4 (needs the privileged key). This
  story's "indistinguishable" tests assert the CONTRACT (same reason/degraded, remote-not-called),
  not a byte-diff against a live backend.
- **Any seam / port / `FlagContext` / `FlagSet` / `FlagReason` change** — the whole point is zero seam
  change. `onlyEvaluateLocally`/`strictLocalEvaluation`/poll-interval/definitions-endpoint are ADAPTER
  CONFIG on `FlagClientConfig`, never on the neutral port. If a new reason value or context field seems
  needed, STOP — that's an E12-was-wrong escalation.
- **`$feature_flag_called` auto-capture / flag-exposure events** — deferred at the E12 level; local
  eval fires no capture.

## Acceptance criteria

- [ ] `evaluate` is UNCHANGED in signature and the neutral `FeatureFlagPort`/`FlagContext`/`FlagSet`/
      `FlagReason` are untouched — local eval is a strategy branch inside the adapter, verified by a
      diff that adds no seam surface (the E13 regression check: E12's port shape held).
- [ ] With local eval configured, a locally-resolvable flag resolves WITHOUT a remote round-trip (a
      test asserts the injected remote fetch was not called for it); an inconclusive flag falls back to
      the SHIPPED remote path (the same `roundTrip`, not a second client) and the merged `FlagSet`
      carries both flags coherently.
- [ ] `onlyEvaluateLocally` (per the resolved default incl. `strictLocalEvaluation`) suppresses the
      fallback — an inconclusive flag resolves to its degraded neutral state, no round-trip fires. All
      three knobs are `FlagClientConfig` fields, NOT neutral port parameters.
- [ ] A locally-resolved flag and a remotely-resolved flag are indistinguishable to the consumer: the
      same `degraded`/`reason` signal, and the `isEnabled`/`getFlag`/`getPayload`/`getAll` reads behave
      identically regardless of strategy (a test reads the same key both ways and asserts identical
      surface behavior). A local eval failure reads identically to a remote failure.
- [ ] `distinctId`-required still throws a neutral error pre-eval; `onChange` still fires exactly once;
      the `FrozenNodeMembers` pin stays green (no `flags` member added to `NodeAnalytics`).
- [ ] Enabling/tuning local eval is config-only (bar B): a definitions endpoint + privileged credential
      + the knobs on `FlagClientConfig` select the local-capable adapter with zero library change; an
      adapter given only a remote endpoint stays remote-only (bar A: local eval is a capability an
      adapter MAY add, never one the port requires).
- [ ] No leaked poll timer in the test suite (TS analog of the E12-S4 daemon-thread lesson: fake timers
      or explicit stop; the suite is deterministic green with and without this file).
- [ ] Neutrality: `grep -ri posthog ts/packages/node/src` clean; the knobs/endpoint/credential naming
      carries no vendor token; `pnpm neutrality-scan` green.
- [ ] Gates green: `pnpm --filter @analytics-kit/node build test typecheck lint`; all tests mock the
      round-trip + poller fetch, never a live backend or live key.

## Technical notes

- **Fallback reuses E12's remote path EXACTLY (— architect 2026-07-10, epic Notes):** when local eval
  can't resolve a flag, call the SAME remote machinery E12 shipped (`http-flag-adapter.ts`'s
  `roundTrip`/`fetchFlags`), so a partly-local-partly-remote result is one coherent `FlagSet`. Do NOT
  fork a second remote client. The remote path is already cleanly separable for exactly this — E12-S3's
  `Shipped` note confirms local eval adds a strategy branch INSIDE the adapter, zero seam/port change.
- **`onlyEvaluateLocally`/`strictLocalEvaluation` are adapter config, resolved from the config object,
  never neutral port parameters (— architect 2026-07-10, epic Notes):** the node adapter reads them off
  `FlagClientConfig`; a browser adapter would ignore them (no local mode). E13 is where E12's
  "local-vs-remote is adapter-internal behind one method" decision is exercised. Effective value =
  `onlyEvaluateLocally ?? strictLocalEvaluation ?? false` (the reference default). —
  posthog-source-guide (2026-07-10).
- **The returned `FlagSet` must be indistinguishable from E12's (— architect 2026-07-10, epic Notes):**
  a consumer cannot tell whether a flag was served locally or remotely. Concretely the local path emits
  the SAME neutral `degraded`/`reason` signal E12 defined (a flag that fell back and failed reads
  identically to a remote failure), and the snapshot read surface behaves identically regardless of
  strategy. This is what makes "local-vs-remote is adapter-internal" true rather than aspirational —
  reuse the EXISTING `buildFlagSet` + the frozen `FlagReason` union; add no new reason value.
- **Local eval reads person/group props straight off `FlagContext` (— architect 2026-07-10, epic
  Notes):** E12's locked `FlagContext` already carries `personProperties`/`groupProperties`/`groups`/
  `distinctId` — exactly what the S1 in-process matcher needs to evaluate without a round-trip. This is
  the concrete reason E12's port shape holds for E13 with zero seam change: the context the remote path
  forwards is the same context the local path matches against.
- **The merge happens at the `Snapshot` map level, then ONE `buildFlagSet` (code-shape pin against the
  SHIPPED adapter):** the shipped remote path is `evaluate → roundTrip(context) → fetchFlags(context)`
  where `roundTrip` returns the adapter-internal `Snapshot` (`{ flags, payloads, reason, degraded }`,
  `http-flag-adapter.ts:54-59`) with a SINGLE snapshot-level `reason`/`degraded` — NOT per-flag reasons,
  NOT a `FlagSet`. So the strategy branch does NOT get per-flag remote reasons for free. Do the merge on
  the `flags`/`payloads` MAPS: (1) build the locally-resolved `{flags, payloads}` from the S1 evaluator;
  (2) collect the keys that threw inconclusive as the fallback set; (3) unless `onlyEvaluateLocally`,
  call the SHIPPED `roundTrip(context)` (optionally narrowing `context.flagKeys` to the fallback set so
  the remote body only asks for the unresolved) and layer its `flags`/`payloads` OVER the still-unresolved
  keys — locally-resolved keys are KEPT, only the unresolved get remote values; (4) wrap the merged maps
  in ONE `buildFlagSet<TX>({ flags, payloads, reason, degraded })`. The snapshot-level `reason` for a
  mixed result: `resolved` when everything resolved (locally or remotely) cleanly; `unresolved`/`degraded`
  when a fallback flag still could not resolve — reuse the EXISTING reason-derivation, add no per-flag
  reason field (that would be a `Snapshot`-shape change; the frozen `FlagReason` stays snapshot-uniform).
  This is per-flag on the MAPS, all-at-once on the reason — mirrors the reference `getAllFlags` layering
  within E12's snapshot-uniform-reason shape.
- **Config surface: put the knobs on `FlagClientConfig`, not `NodeAnalyticsConfig`, not the seam.**
  `FlagClientConfig` (`flags/config.ts`) is currently `{ key?, flagEndpoint?, taxonomy?, bootstrap?,
  fetch? }` (5 fields); add `definitionsEndpoint?` + the privileged-credential field (role-named, e.g.
  `definitionsKey?` — never `personalApiKey`) + `pollInterval?` + `onlyEvaluateLocally?` +
  `strictLocalEvaluation?` there. The seam `FlagsConfig.bootstrap` and the neutral port stay untouched.
- **Factory selection wrinkle — local-capability is ADDITIVE to the shipped 3-way branch (pin against
  `create-flag-client.ts`):** the shipped factory is (a) no `key` ⇒ `FlagNoop`; (b) `key` but no
  `flagEndpoint` ⇒ warn-once + `FlagNoop`; (c) `key` + `flagEndpoint` ⇒ `HttpFlagAdapter` remote-only.
  S2 adds local-capability as a CONSTRUCTION OPTION on branch (c), not a new branch: when
  `definitionsEndpoint` + the privileged credential are ALSO present, construct the adapter local-capable
  (poller/evaluator on); else remote-only exactly as shipped. **Edge — local-only with NO remote
  `flagEndpoint`:** a consumer running `onlyEvaluateLocally` may not supply `flagEndpoint`, but branch (b)
  currently warns→`FlagNoop` on `key`-without-`flagEndpoint`. Resolve it so that `key` +
  `definitionsEndpoint` + privileged credential (even without `flagEndpoint`) selects a local-capable
  adapter rather than the no-op — the fallback `roundTrip` is simply never reached under
  `onlyEvaluateLocally`. Keep the warn→`FlagNoop` ONLY for the genuinely-nowhere-to-go case (`key` set,
  neither `flagEndpoint` nor `definitionsEndpoint`). This keeps bar B honest for the local-only posture.
- **E13's load-bearing invariant:** ZERO seam/port change. This is the regression check on E12 — the
  whole story ships behind the unchanged `evaluate`. If the wiring seems to need a port change, that's
  an E12-was-wrong escalation, not a story decision.

> Reviewer suggestion (2026-07-10): No test covers a mixed local + failed-remote-fallback-WITH-bootstrap merge (a local flag resolves, the fallback fails, `roundTrip` serves the `'stale'` bootstrap seed → the wholesale `reason: remote.reason` adoption makes the clean local flag read `'stale'`+degraded — correct snapshot-uniform behavior, only exercised via the no-bootstrap `unresolved` path today). The `bootstrap` plumbing is already in the test helper but unused; one test would pin the `'stale'`-wins-on-mixed contract. (Improvement-pass candidate.)
> Reviewer suggestion (2026-07-10): In the tests, `poller.stop()` is redundant after `adapter.stop()` (which delegates to it). Cosmetic — dropping the extra call would make "the adapter owns its timer" read clearer.

## Shipped

> Captured by `implement-epics` on 2026-07-10.

- **Files changed:** `ts/packages/node/src/flags/{config.ts,create-flag-client.ts,http-flag-adapter.ts}` (+ `create-flag-client.test.ts`)
- **Files added:** `ts/packages/node/src/flags/local-resolution.test.ts` (12 tests)
- **New public API:** none new on the neutral surface. `FlagClientConfig` gained 5 local-eval fields (`definitionsEndpoint?`, `definitionsKey?` (role-named privileged), `pollInterval?`, `onlyEvaluateLocally?`, `strictLocalEvaluation?`); `flagEndpoint?` is now optional (local-only posture). The local strategy branch (`resolveLocalFirst`/`resolveLocalPayload`/`stop`) + `LocalEvalCapability` are adapter-internal.
- **Tests added:** `local-resolution.test.ts` (12) + `create-flag-client.test.ts` (+6). Cover: local-first resolves with ZERO POST (call-count asserted), both inconclusive signals → ONE narrowed `roundTrip`, merged set carries both flags, `onlyEvaluateLocally` suppresses fallback (no POST, degraded/unresolved), unknown key drops out (not a fallback key), not-ready path uses ORIGINAL context, local-vs-remote indistinguishable (both clean + failed-fallback), factory local-only selection.
- **Commit:** `main` (message = story title)
- **Reviewer notes:** ship-ready, no critical, first review. Reviewer verified all 8 checks in code + reference: zero-seam-change (evaluate signature + `FlagReason` frozen, `FrozenNodeMembers` green, no package-index leak), fallback correctness non-vacuous (zero-POST call-count asserted, both flags in the merge, `flag_keys_to_evaluate` narrowed to the fallback set), both architect-corrected edges, `onlyEvaluateLocally` suppression, factory local-only fix, indistinguishability (genuinely different code paths asserted identical), no leaked poll timer. Key insight: **narrowing to fallback keys is a deliberate improvement over the reference** (posthog re-fetches ALL flags; this guarantees a locally-decidable flag issues ZERO POST). 2 suggestions captured.
- **Cross-story seams exposed:** **S3 (Python)** — replicate this EXACT branch on the SYNC path: local-first over the poller snapshot, catch BOTH inconclusive signals → collect keys → unless local-only, ONE `_round_trip` narrowed to the fallback set → merge on the flags/payloads dicts (local base, remote layered over) → wrap ONCE; effective local-only = `only_evaluate_locally or strict_local_evaluation or False`; degraded-WINS on mixed (adopt the round-trip's reason/degraded); payload off `definition.filters.payloads[str(value)]`, JSON-parse strings, omit-not-null; all-sync (poller is the only I/O boundary); knobs on the Python flag-client config, never the neutral port; fix the Python factory's local-only edge the same way; **and (the E12-S4 lesson) the Python poll loop must be a STOPPABLE daemon every test halts — no leaked thread.** **S4 (proof)** — this branch is the local path S4 diffs vs a real remote; a fully-local-decidable set must issue ZERO remote calls (a negative control); `send_cohorts` live wiring + ETag follow-up still open.

## Follow-up

> Improvement pass (2026-07-10, commit `E13 improvement pass`).
- **`'stale'`-wins-on-mixed test** — added the coverage gap the reviewer flagged: a local flag resolves, a second is inconclusive → the fallback `roundTrip` fails but a `bootstrap` seed is present → the WHOLE merged set (incl the CLEAN local flag) reads `reason==='stale'`+`degraded===true`, 1 POST. Reviewer independently mutation-checked it bites: a naive per-flag reason (`RESOLVED` for local keys) fails at `reason('local_on')` — the clean flag is the non-vacuous assertion.
- **Redundant `poller.stop()` dropped** in the `makeLocalAdapter`-based tests (the adapter owns that poller; `adapter.stop()` delegates) — cosmetic; standalone-poller `stop()`s kept, thread-leak guard not weakened.
