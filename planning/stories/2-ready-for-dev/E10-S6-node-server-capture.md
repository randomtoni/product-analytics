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
- A runnable vitest test proving: node capture of `plan_upgraded` on the given distinct id reaches delivery with the supplied `dedupeId`; a duplicate `dedupeId` models idempotency; `shutdown()` drains and resolves.

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

## Technical notes

- **Node is a sibling, not the facade (E7 watch-item, locked).** — from E7-S6 (2026-07-08): node's `NodeAnalytics<TX>` surface (`capture(distinctId, event, props?, {dedupeId}?)` + `setTraits`/`setGroupTraits`/`flush`/`shutdown`) is intentionally NARROWER + differently-named than the seam facade (`capture(distinctId,…)` not `track`; required `distinctId`). E10 must present browser + node as SIBLINGS, not one client. Do NOT try to unify them.
- **Await `shutdown()` in the signal handler (E7 watch-item, locked).** — from E7-S6 (2026-07-08): `shutdown()` resolves-not-rejects on timeout (a rejecting shutdown in a SIGTERM handler is an unhandled-rejection footgun), with a `console.error` as the only drop signal. The example's handler must `await client.shutdown()` so the drain window is actually used. `packages/node/src/node-analytics.ts` — `shutdown()` sets `stopped` first, loop-drains, races a configurable timeout.
- **Node config + factory.** `@analytics-kit/node` `createAnalytics(config: NodeAnalyticsConfig)` — SINGLE arg; `key` is the INGEST write key (distinct from query's `personalKey`). Unkeyed ⇒ `NodeNoop` whole-stack no-op (bar B). `NodeAnalyticsConfig`: `key`/`taxonomy`/`allowlist`/`onViolation`/`ingestHost`/`ingestPath`/`fetch`/flush knobs (`packages/node/src/config.ts`). `CaptureOptions = { dedupeId? }` → wire `uuid` idempotency.
- **Mock transport, not mock adapter (node has no injectable adapter).** — architect (2026-07-08): node's factory builds its own transport; its public injection seam is `config.fetch: FetchLike`. To run against a mock with no real backend, set `key` + `ingestHost` and inject a `fetch` that captures the delivered batch — assert the neutral→wire delivery there. Never hit a real endpoint. (Alternatively assert on `flush()`/`shutdown()` resolution + type-level capture typing if delivery inspection is out of scope for a slice.)
- **Same taxonomy, every surface.** Import the S2 `defineTaxonomy` object; `plan_upgraded` and its props type-check identically through node `capture` as through browser `track`.

## Shipped
