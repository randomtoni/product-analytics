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

- **Node flag adapter module (`ts/packages/node/src/flags/` subdir — `create-flag-client.ts` + a role-named client class, mirroring the `query/` layout)** — a class implementing the S1 `FeatureFlagPort<TX>`, reached via its OWN standalone factory (see the node-attach note below — node has NO `provider.flags` slot):
  - `evaluate(context)` → a remote round-trip (de-branded from node's `evaluateFlags` remote path) returning the `FlagSet` snapshot for the resolved actor.
  - **`distinctId` required + validated** — the adapter throws a clear neutral error when `context.distinctId` is absent (no ambient actor, mirrors node `evaluateFlags(distinctId, …)`). This is the server half of the E4 `sessionId` asymmetry.
  - `onChange` fires **once** with the resolved snapshot on the first `evaluate` (the stateless-server degenerate case, per S1), then never again; the returned unsubscribe is a no-op-after-fire.
  - Map the neutral degradation signal from round-trip success/failure/partiality; vendor eval-quality fields (`errorsWhileComputing`/`quotaLimited`/`requestId`/per-flag reason) stay adapter-internal.
  - Bootstrap: the node adapter accepts `config.flags.bootstrap` (SSR request-scoped seeding) as a resolved-set fallback where meaningful, per the S1 "Python/Node accept bootstrap too" note — but the server path is remote-round-trip-primary. Keep bootstrap consumption minimal and honest (a seed/fallback, not a client-style flash guard).
- **Node flag-client factory + export (`ts/packages/node/src/flags/create-flag-client.ts` + `ts/packages/node/src/index.ts`)** — a standalone `createFlagClient(config)` factory (role-named; mirrors `createQueryClient`) returning the `FeatureFlagPort<TX>`-satisfying client; keyed config selects the real remote client, unkeyed/endpointless returns a null-object flag client (bar B — the `query-noop.ts` precedent). Give it its OWN config type (a `FlagClientConfig` in `flags/config.ts`, mirroring `query/config.ts`'s separate `QueryClientConfig`) carrying the flag-eval endpoint + `taxonomy` + a consumer-injectable `fetch` — NOT a new field on `NodeAnalyticsConfig`; the flag round-trip endpoint differs from the ingest endpoint, exactly as the query endpoint does. Bootstrap: `config.flags.bootstrap` is on the SEAM `AnalyticsConfig` (S1) — the node flag-client config accepts an equivalent bootstrap seed field where meaningful (SSR request-scoped), remote-round-trip-primary; keep it a minimal seed/fallback (see the bootstrap Scope bullet below), not a client-style flash guard. Export the factory + the `FeatureFlagPort` type re-export from node's `index.ts` alongside `createQueryClient`/`AnalyticsQueryClient`. **Do NOT touch `NodeAnalytics` or `createAnalytics`** — the node capture surface `NodeAnalytics` is a frozen 5-member interface (`node-analytics.ts:51`, pinned by `capability-presence.ts:57` `FrozenNodeMembers`) with NO `flags` slot; the flag client is a sibling capability, exactly as the query client is. Config-only.
- **Tests** — against a mock round-trip (never a real backend): `distinctId`-required validation throws; `evaluate` resolves the snapshot; `onChange` fires exactly once with the resolved set; `degraded`/`reason` on a failed round-trip; taxonomy-typed reads narrow.

### Out

- **Local (in-process) eval** — definition polling + `matchProperty` cohort/rollout/hashing, `onlyEvaluateLocally`/`strictLocalEvaluation` adapter config — **E13**, behind this unchanged `evaluate` method. If E13 needs a seam change, the E12 port shape was wrong.
- **Browser / Python adapters** — S2 / S4.
- **The React hook** — S5.
- **`$feature_flag_called` auto-capture** — node's snapshot `_recordAccess` fires `$feature_flag_called` carrying `$feature/*` / `$feature_flag_response` / `$active_feature_flags` / `$feature_flag_request_id` — all `$`-prefixed vendor shapes. Explicitly NOT ported; reading a flag emits no event.

## Acceptance criteria

- [ ] The node flag client satisfies the S1 `FeatureFlagPort<TX>` exactly (same interface as the browser adapter — bar A: one neutral port, two targets, zero consumer change). It is reached via a standalone `createFlagClient(config)` factory exported from node's `index.ts` (mirroring `createQueryClient`), NOT via a `provider.flags` slot — `NodeAnalytics` is unchanged and its `FrozenNodeMembers` pin stays green. A keyed+endpointed config returns the real remote client; an unkeyed/endpointless config returns the null-object flag client (bar B).
- [ ] `evaluate(context)` with no `context.distinctId` throws a clear neutral error (no vendor token in the message); with `distinctId` it returns the resolved `FlagSet` via the mocked round-trip.
- [ ] `onChange` fires exactly once with the resolved set (a test asserts the once-cardinality); the unsubscribe returned is sound (no throw, no second fire).
- [ ] A failed round-trip sets `FlagSet.degraded = true` + a neutral `reason`; no vendor eval-quality field (`errorsWhileComputing`/`quotaLimited`/`requestId`) leaks onto the snapshot.
- [ ] Taxonomy typing flows through the flag client's `getPayload`/`getFlag` (a type-test) — identical narrowing to the browser adapter, since both are `FeatureFlagPort<TX>`. The factory carries `TX` from a typed `config.taxonomy` exactly as `createQueryClient` does (`createFlagClient<const T>(config & { taxonomy: Taxonomy<T> }): FeatureFlagPort<ShapeOf<T>>` overload + a `DefaultTaxonomyShape` fallback overload).
- [ ] Neutrality: `grep -ri posthog ts/packages/node/src` clean; the flag-eval endpoint + request/response shapes confined to `$`-const/`[WIRE]` internals; `pnpm neutrality-scan` green.
- [ ] Gates green: `pnpm --filter @analytics-kit/node build test typecheck lint`; tests mock the round-trip, never a live backend.

## Technical notes

- **Node attach = standalone factory, NOT a provider slot (— architect 2026-07-10):** node's consumer capture surface is `NodeAnalytics<TX>` (`node-analytics.ts:51`), a SEPARATE 5-member interface (`capture`/`setTraits`/`setGroupTraits`/`flush`/`shutdown`) with NO `flags` slot, and its member set is frozen by `capability-presence.ts:57` (`FrozenNodeMembers`) — adding a `flags` member would break that pin and is out of scope. The `flags?` slot the seam declares lives on `AnalyticsProvider` (the browser-facing facade node does NOT extend). So node reaches the flag capability the SAME way it reaches the query capability: a standalone `createFlagClient(config)` factory returning a `FeatureFlagPort<TX>`-satisfying client, exported from node's `index.ts` — mirror `query/create-query-client.ts` + `query-noop.ts` verbatim (a `flags/` subdir). Bar A is satisfied by the client satisfying the SAME neutral `FeatureFlagPort<TX>` the browser adapter does — how a consumer OBTAINS the port (browser slot vs. node factory) is a target-surface concern; WHAT they get (the neutral port) is the bar-A concern, exactly as query already establishes browser↔node capability-surface asymmetry (browser has no query client; node does — flags is the same story, roles as they fall). `onChange` once-fire + `distinctId`-required are properties of the PORT CONTRACT and are unchanged by the standalone-factory attach. `distinctId`-required is reinforced here: node has no persisted identity, so the per-call `distinctId` is the ONLY eval-identity source (same as node `capture`'s arg-1 `distinctId`) — a slot on an ambient `provider` would falsely imply an identity node doesn't carry, another argument FOR the factory shape.
- reference: `posthog-js/packages/node/src/client.ts` (`evaluateFlags` remote path — the `@deprecated` per-key `getFeatureFlag`/`isFeatureEnabled`/`getAllFlags` are the shape PostHog steers AWAY from; port the `evaluateFlags` → snapshot path) + `feature-flag-evaluations.ts` (the `FeatureFlagEvaluations` snapshot to neutralize into `FlagSet`). De-brand. Consult `posthog-source-guide` for whether node's remote path buffers/flushes and the exact request shape before porting.
- **`distinctId` required on server (— architect 2026-07-10):** validated by the adapter (no ambient actor). The neutral error message must carry NO vendor token. Do NOT invent a fake ambient actor to force a browser-identical no-arg call — the asymmetry is the honest neutral shape (E4 `sessionId` precedent).
- **`onChange` once-cardinality (— architect 2026-07-10):** a stateless server client has no push-based flag stream — flags are pull-per-`evaluate`. `onChange` is the degenerate case of the same signature: fires once on the resolved snapshot, then never. Same signature as browser, different cardinality — document as an adapter property and assert it in a test.
- **`_recordAccess` / `$feature_flag_called` is the biggest leak risk in the epic (— architect 2026-07-10):** node's snapshot fires it on read, coupling flags to the capture pipeline and carrying `$`-shapes. Confirmed OUT of v1 — the node adapter's `evaluate`/snapshot reads must NOT trigger any capture. When flag-exposure auto-capture is added later it emits through the neutral capture surface with neutral property names, `$feature/*` shapes staying behind the adapter.
- **E13 regression check:** local eval slots definition-polling + in-process evaluation entirely behind this `evaluate` method with ZERO seam change. Keep the remote path cleanly separable so E13 adds a strategy branch inside the adapter, not a port change.

## Shipped

<!-- Empty at draft. /implement-epics fills this once, when the story moves to stories/5-done/. Do not hand-edit. -->
