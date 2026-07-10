---
id: E12-S3-node-remote-eval-adapter
epic: E12-FF-flag-substrate-remote-eval
status: ready-for-dev
area: feature-flags
touches: [node]
depends_on: [E12-S1]
api_impact: additive
---

# E12-S3-node-remote-eval-adapter — Node remote-eval flag adapter (TS)

## Why

The server half of remote eval: `evaluate(context)` → a remote round-trip returning the `FlagSet` snapshot, with `distinctId` required and validated (no ambient server actor). This is the TS-node target satisfying the SAME neutral `FeatureFlagPort` as the browser adapter — proving **bar A** across a second target with an entirely different (async round-trip, no persistence, no init fetch) implementation.

## Scope

### In

- **Node flag adapter module (`ts/packages/node/src/feature-flags.ts` or similar, named by role)** — a class implementing the S1 `FeatureFlagPort`:
  - `evaluate(context)` → a remote round-trip (de-branded from node's `evaluateFlags` remote path) returning the `FlagSet` snapshot for the resolved actor.
  - **`distinctId` required + validated** — the adapter throws a clear neutral error when `context.distinctId` is absent (no ambient actor, mirrors node `evaluateFlags(distinctId, …)`). This is the server half of the E4 `sessionId` asymmetry.
  - `onChange` fires **once** with the resolved snapshot on the first `evaluate` (the stateless-server degenerate case, per S1), then never again; the returned unsubscribe is a no-op-after-fire.
  - Map the neutral degradation signal from round-trip success/failure/partiality; vendor eval-quality fields (`errorsWhileComputing`/`quotaLimited`/`requestId`/per-flag reason) stay adapter-internal.
  - Bootstrap: the node adapter accepts `config.flags.bootstrap` (SSR request-scoped seeding) as a resolved-set fallback where meaningful, per the S1 "Python/Node accept bootstrap too" note — but the server path is remote-round-trip-primary. Keep bootstrap consumption minimal and honest (a seed/fallback, not a client-style flash guard).
- **Node `createAnalytics` wiring (`ts/packages/node/src/create-analytics.ts`)** — construct + attach the flag adapter to the provider `flags` slot when keyed; unkeyed leaves it `undefined`. Config-only.
- **Tests** — against a mock round-trip (never a real backend): `distinctId`-required validation throws; `evaluate` resolves the snapshot; `onChange` fires exactly once with the resolved set; `degraded`/`reason` on a failed round-trip; taxonomy-typed reads narrow.

### Out

- **Local (in-process) eval** — definition polling + `matchProperty` cohort/rollout/hashing, `onlyEvaluateLocally`/`strictLocalEvaluation` adapter config — **E13**, behind this unchanged `evaluate` method. If E13 needs a seam change, the E12 port shape was wrong.
- **Browser / Python adapters** — S2 / S4.
- **The React hook** — S5.
- **`$feature_flag_called` auto-capture** — node's snapshot `_recordAccess` fires `$feature_flag_called` carrying `$feature/*` / `$feature_flag_response` / `$active_feature_flags` / `$feature_flag_request_id` — all `$`-prefixed vendor shapes. Explicitly NOT ported; reading a flag emits no event.

## Acceptance criteria

- [ ] The node flag adapter satisfies the S1 `FeatureFlagPort` exactly (same interface as the browser adapter — bar A: one neutral port, two targets, zero consumer change). A keyed node `createAnalytics(config)` populates `provider.flags`; unkeyed leaves it `undefined`.
- [ ] `evaluate(context)` with no `context.distinctId` throws a clear neutral error (no vendor token in the message); with `distinctId` it returns the resolved `FlagSet` via the mocked round-trip.
- [ ] `onChange` fires exactly once with the resolved set (a test asserts the once-cardinality); the unsubscribe returned is sound (no throw, no second fire).
- [ ] A failed round-trip sets `FlagSet.degraded = true` + a neutral `reason`; no vendor eval-quality field (`errorsWhileComputing`/`quotaLimited`/`requestId`) leaks onto the snapshot.
- [ ] Taxonomy typing flows through `provider.flags.getPayload`/`getFlag` (a type-test) — identical narrowing to the browser adapter, since both are `FeatureFlagPort<TX>`.
- [ ] Neutrality: `grep -ri posthog ts/packages/node/src` clean; the flag-eval endpoint + request/response shapes confined to `$`-const/`[WIRE]` internals; `pnpm neutrality-scan` green.
- [ ] Gates green: `pnpm --filter @analytics-kit/node build test typecheck lint`; tests mock the round-trip, never a live backend.

## Technical notes

- reference: `posthog-js/packages/node/src/client.ts` (`evaluateFlags` remote path — the `@deprecated` per-key `getFeatureFlag`/`isFeatureEnabled`/`getAllFlags` are the shape PostHog steers AWAY from; port the `evaluateFlags` → snapshot path) + `feature-flag-evaluations.ts` (the `FeatureFlagEvaluations` snapshot to neutralize into `FlagSet`). De-brand. Consult `posthog-source-guide` for whether node's remote path buffers/flushes and the exact request shape before porting.
- **`distinctId` required on server (— architect 2026-07-10):** validated by the adapter (no ambient actor). The neutral error message must carry NO vendor token. Do NOT invent a fake ambient actor to force a browser-identical no-arg call — the asymmetry is the honest neutral shape (E4 `sessionId` precedent).
- **`onChange` once-cardinality (— architect 2026-07-10):** a stateless server client has no push-based flag stream — flags are pull-per-`evaluate`. `onChange` is the degenerate case of the same signature: fires once on the resolved snapshot, then never. Same signature as browser, different cardinality — document as an adapter property and assert it in a test.
- **`_recordAccess` / `$feature_flag_called` is the biggest leak risk in the epic (— architect 2026-07-10):** node's snapshot fires it on read, coupling flags to the capture pipeline and carrying `$`-shapes. Confirmed OUT of v1 — the node adapter's `evaluate`/snapshot reads must NOT trigger any capture. When flag-exposure auto-capture is added later it emits through the neutral capture surface with neutral property names, `$feature/*` shapes staying behind the adapter.
- **E13 regression check:** local eval slots definition-polling + in-process evaluation entirely behind this `evaluate` method with ZERO seam change. Keep the remote path cleanly separable so E13 adds a strategy branch inside the adapter, not a port change.

## Shipped

<!-- Empty at draft. /implement-epics fills this once, when the story moves to stories/5-done/. Do not hand-edit. -->
