---
id: E10-S6-node-server-capture
epic: E10-CORE-example-consumer
status: ready-for-dev
area: core
touches: [example, node, capture]
depends_on: [E10-S2-fernly-taxonomy-identity-mapping]
api_impact: additive
---

# E10-S6-node-server-capture — Node-side server capture of plan_upgraded on the same distinct id

## Why

Exercises E7: a node-side handler captures a server-truth event (`plan_upgraded`) keyed on the SAME distinct id used client-side, carrying an insert/dedupe id for idempotent retries. This proves the server target adopts the same taxonomy config-only, as a SIBLING of the browser client — not a unified client.

## Scope

### In

- A node-side Fernly handler (`examples/fernly/src/server/`) using `@analytics-kit/node` `createAnalytics(config)` → `NodeAnalytics<TX>`, typed off the SAME Fernly taxonomy from S2.
- `capture(distinctId, 'plan_upgraded', props, { dedupeId })` keyed on the same distinct id a client-side slice would use, with a caller-supplied `dedupeId` for idempotent retries. Optionally `setTraits(distinctId, traits)` / `setGroupTraits('workspace', key, traits)` for server-side property updates.
- **`shutdown()` awaited in a signal handler**: demonstrate a SIGTERM/SIGINT handler that `await client.shutdown()` so the drain window is used (the epic's E7 watch-item). Runnable as a test that calls the handler and asserts the drain completed.
- A runnable vitest test proving: node capture of `plan_upgraded` on the given distinct id reaches delivery carrying the supplied `dedupeId` as the wire `uuid` (assert on the injected-`fetch` batch body); a duplicate `dedupeId` yields the same wire `uuid` twice (the backend-dedupe idempotency model — the client does NOT drop it); `shutdown()` drains and resolves.

### Out

- The browser/react slices (S8) and query (S7). This story wires the node target only.
- Any real backend endpoint — the node harness mocks transport via the injected `fetch` (see Technical notes), never a real POST.
- Selecting a warehouse/query adapter (that's S7) and any `packages/*` edit.

## Acceptance criteria

- [ ] The node handler uses `@analytics-kit/node` `createAnalytics(config)`, typed off the SAME Fernly taxonomy (imported from S2) — proven by `capture` type-checking the event name + props.
- [ ] `capture(distinctId, 'plan_upgraded', props, { dedupeId })` keys on the same distinct id and carries the dedupe id — asserted on the mocked delivery.
- [ ] A signal handler `await`s `client.shutdown()`; the drain window is used and `shutdown()` resolves (not rejects).
- [ ] The node client is shown as a SIBLING of the browser client — NOT a unified client (distinct `capture(distinctId,…)` signature vs the facade's `track`).
- [ ] `turbo run typecheck` + `turbo run test` pass for `examples/fernly`.
- [ ] **Bar-B diff invariant (enforced):** this story's changeset touches only `examples/**` — nothing under `packages/**`, verifiable by diff. If a required capability appears missing, it is a **bar-B failure** — file it as a bug against the owning epic (E2–E9) per the epic Notes; do NOT patch `packages/*` in E10.

## Technical notes

- **Node is a sibling, not the facade (E7 watch-item, locked).** — from E7-S6 (2026-07-08): node's `NodeAnalytics<TX>` surface (`capture(distinctId, event, props?, {dedupeId}?)` + `setTraits`/`setGroupTraits`/`flush`/`shutdown`) is intentionally NARROWER + differently-named than the seam facade (`capture(distinctId,…)` not `track`; required `distinctId`). E10 must present browser + node as SIBLINGS, not one client. Do NOT try to unify them.
- **Await `shutdown()` in the signal handler (E7 watch-item, locked).** — from E7-S6 (2026-07-08): `shutdown()` resolves-not-rejects on timeout (a rejecting shutdown in a SIGTERM handler is an unhandled-rejection footgun), with a `console.error` as the only drop signal. The example's handler must `await client.shutdown()` so the drain window is actually used. `packages/node/src/node-analytics.ts` — `shutdown()` sets `stopped` first, loop-drains, races a configurable timeout.
- **Node config + factory.** `@analytics-kit/node` `createAnalytics(config: NodeAnalyticsConfig)` — SINGLE arg; `key` is the INGEST write key (distinct from query's `personalKey`). Unkeyed ⇒ `NodeNoop` whole-stack no-op (bar B). `NodeAnalyticsConfig`: `key`/`taxonomy`/`allowlist`/`onViolation`/`ingestHost`/`ingestPath`/`fetch`/flush knobs (`packages/node/src/config.ts`). `CaptureOptions = { dedupeId? }` → wire `uuid` idempotency.
- **Mock transport, not mock adapter (node has no injectable adapter).** — architect (2026-07-08): node's factory builds its own transport; its public injection seam is `config.fetch: FetchLike`. To run against a mock with no real backend, set `key` + `ingestHost` and inject a `fetch` that captures the delivered batch — assert the neutral→wire delivery there. Never hit a real endpoint. (Alternatively assert on `flush()`/`shutdown()` resolution + type-level capture typing if delivery inspection is out of scope for a slice.)
- **Delivery assertion shape (pin this).** Node BATCHES — the injected `fetch` only fires after a flush trigger (`await client.flush()`, or hitting `flushAt`, or the drain inside `await client.shutdown()`). So the test must `capture(...)` then flush, then read the POSTed body. The `dedupeId` lands on the WIRE as **`uuid`** (top-level idempotency key), NOT as `dedupeId` — VERIFIED `packages/node/src/wire-mapper.ts` (`uuid: event.dedupeId`) and `packages/node/src/send-batch.ts` (POSTs to `ingestHost + ingestPath` with a JSON body via `config.fetch`). Assert `batch.events[i].uuid === <the supplied dedupeId>`, not a `dedupeId` field. A duplicate `dedupeId` yields the same wire `uuid` — that IS the idempotency model (the backend dedupes on it; the client does not drop it).
- **Same taxonomy, every surface.** Import the S2 `defineTaxonomy` object; `plan_upgraded` and its props type-check identically through node `capture` as through browser `track`.

## Shipped
- > Reviewer suggestion (2026-07-09, improvement-pass candidate): `ShapeOfFernly` is derived indirectly via `ReturnType<typeof createAnalytics<...>> extends NodeAnalytics<infer TX>` — the seam exports `ShapeOf`, so `NodeAnalytics<ShapeOf<FernlyTaxonomy['decl']>>` would express intent directly. Cosmetic.
- > Reviewer suggestion (2026-07-09): the mock `fetch` is cast `as unknown as FetchLike` because `FetchLike = typeof fetch` is wider than node's transport uses — inherent to the public seam type, not the test; if node ever exports a narrower fetch contract the cast could drop.

## Shipped

> Captured by `implement-epics` on 2026-07-09. Exercises E7 node server capture as a SIBLING of the browser client (bar B).

- **Files added (examples ONLY — bar B):** `server/plan-upgrade-handler.ts` (`createFernlyServerAnalytics`, `handlePlanUpgrade` = `capture(distinctId,'plan_upgraded',props,{dedupeId})` + `setTraits` + `setGroupTraits('workspace',…)`, `createShutdownHandler` testable async fn awaiting `shutdown()`, `registerShutdownHandler` SIGTERM/SIGINT via `process.once`) + `.test.ts`
- **Files changed (examples):** `index.ts` (barrel exports the server handler symbols)
- **New public API:** none — example-only. ZERO `packages/**` edits (bar B). Same `fernlyTaxonomy` types node `capture` identically to browser `track` (one taxonomy every surface).
- **Node = SIBLING, not the facade (crux, E7 watch-item):** narrow `capture(distinctId,'plan_upgraded',props,{dedupeId})` with REQUIRED positional distinctId — NO `track`, no unified wrapper (grep-confirmed). The distinct signature IS the proof.
- **Delivery + idempotency (rigorous):** node BATCHES → injected `config.fetch` fires only after a flush trigger; test `capture` → `await flush()` → gunzips the default-gzipped body (off the real `Content-Encoding` header) → asserts `events[i].uuid === dedupeId` (NOT a `dedupeId` field; `+ not.toHaveProperty('dedupeId')`). Idempotency BOTH directions: duplicate dedupeId → `[dedupeId, dedupeId]` (client does NOT drop — backend dedupes on the shared uuid); no-dedupeId → two distinct minted uuids. Mock transport via `config.fetch` (node has no injectable adapter), never a real endpoint.
- **await `shutdown()` drains + resolves-not-rejects:** the test buffers WITHOUT flushing, asserts empty deliveries, then the shutdown handler resolves AND the drain delivered the buffered event (drain window genuinely used, with teeth). Unkeyed → `NodeNoop` no-op (bar B — fetch never called).
- **Non-partial trait/group bags = contract not gap:** `setTraits` needs full `TX['traits']`, `setGroupTraits('workspace')` full group — API working as designed (full-shape sets); no bar-B bug filed.
- **Tests added:** fernly +7 (dedupeId→wire-uuid, whole-handler same-distinct-id + set_traits nesting, duplicate→same-uuid-twice, no-dedupeId-mints-distinct, await-shutdown-drains-resolves, unkeyed-no-op, SIGTERM/SIGINT registration) → 63; turbo typecheck+test green; bar-B holds
- **Commit:** `E10-S6-node-server-capture — Node-side server capture of plan_upgraded on the same distinct id` on `core-cycle`
- **Reviewer notes:** ship-ready — 0 critical, 2 cosmetic suggestions
- **Cross-story seams exposed (S7):** query is a SEPARATE node surface — `createQueryClient(config)` → `AnalyticsQueryClient` (`funnel`/`retention`/`trend`/`uniqueCount`/`rawQuery`); config uses `personalKey` (query READ key) NOT this story's ingest write `key`; imports the SAME `fernlyTaxonomy`; lands under `examples/fernly/src/` (e.g. `queries/`, sibling to `server/`); does NOT touch this handler.
