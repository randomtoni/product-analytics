---
id: E7-S6-noop-and-lifecycle
epic: E7-NODE-server-capture
status: ready-for-dev
area: node
touches: [adapters]
depends_on: [E7-S3-server-batch-queue, E7-S4-batch-delivery-wire]
api_impact: additive
---

# E7-S6-noop-and-lifecycle — No-op-without-key + flush/shutdown lifecycle

## Why

Closes the epic: an unkeyed node client is a whole-stack silent no-op (bar B: config-only adoption, an unconfigured environment sends nothing), and a server process must drain its buffer before exit. This story wires the config-selected no-op path and the real `flush()` / `shutdown()` lifecycle with a configurable drain timeout.

## Scope

### In

- No-op-without-key: when `config.key` is absent, `createAnalytics(config)` yields a whole-stack silent no-op node client — `capture` / `setTraits` / `setGroupTraits` accept calls and do nothing; the queue never sends; `flush()` / `shutdown()` resolve immediately. **Shape: a node-local null-OBJECT client (`NodeNoop`) that implements the `NodeAnalytics` client interface** — NOT the seam's `NoopAdapter`. The seam `NoopAdapter` implements `AnalyticsAdapter` (a different, wider interface: `capture(NeutralEvent)`/`identify`/`getDistinctId`/`fetch`/persistence…) — node is a standalone client (shape A), not adapter-driven, so `NoopAdapter` does NOT structurally satisfy `NodeAnalytics` and can't be reused directly. Mirror the *pattern* the browser factory uses (`packages/browser/src/create-analytics.ts:44-45` — `config.key === undefined ? new NoopAdapter() : new BrowserAdapter(...)`): node's `createAnalytics` returns `config.key === undefined ? new NodeNoop() : new NodeAnalytics(...)`. Prefer this null-object route over a scattered `disabled` guard flag inside the real client, so "unkeyed ⇒ no-op" is a property of the null object.
- `flush()`: force-send the buffered queue immediately (bypass the size/interval trigger); resolve once the in-flight POST(s) settle.
- `shutdown()`: drain the queue (flush repeatedly until empty, catching events enqueued mid-drain) and resolve, within a CONFIGURABLE timeout (`shutdownTimeoutMs?` in config; sane default). On timeout, resolve/reject per the ported posture and stop — remaining events are left unsent (in-memory only; ephemeral server, no disk persistence).
- After `shutdown()`, the client is quiesced — the flush timer is cleared; a post-shutdown `capture` is inert (no re-arm).

### Out

- The queue/defaults/overflow internals (E7-S3) and delivery/gzip/413 (E7-S4) — this story drives them via `flush`/`shutdown`, doesn't re-implement them.
- Any disk/durable persistence of the buffer on shutdown — server queue is in-memory; undrained-at-timeout events are lost by design (durability is the consumer's infra concern, per epic Out-of-scope).
- Runtime opt-out/opt-in verbs — not on the node R1 surface (no-op is the config-time unkeyed path, not a consent toggle).

## Acceptance criteria

- [ ] An unkeyed node client (`config.key` absent) is a whole-stack silent no-op: `capture`/`setTraits`/`setGroupTraits` never send; `flush()`/`shutdown()` resolve; nothing hits the transport (bar B: config-only, zero library change).
- [ ] `flush()` force-drains the buffer (bypassing the interval/size trigger) and resolves once the POST(s) settle.
- [ ] `shutdown()` drains the queue within a configurable `shutdownTimeoutMs` (with a sane default) and resolves; it re-flushes to catch events enqueued during the drain.
- [ ] On `shutdown()` timeout, the method settles deterministically and the process is not hung; remaining in-memory events may be unsent (documented, not a bug).
- [ ] After `shutdown()`, the client is quiesced — the flush timer is cleared and a later `capture` does not re-arm delivery.
- [ ] All four gates green.

## Technical notes

- **Whole-stack no-op** — architect (2026-07-07, epic Notes): unkeyed ⇒ same whole-stack no-op posture as E2's config-selected factory; the queue never sends. Reference — posthog-source-guide (2026-07-08): posthog computes `disabled = (options.disabled ?? false) || !normalizedApiKey` once in the core constructor (`posthog-core-stateless.ts:259,287`) and guard-early-returns from `enqueue`/`sendImmediate`. Our seam ships a null-OBJECT `NoopAdapter` (`packages/analytics-kit/src/noop-adapter.ts`) and the browser factory selects it when `config.key` is undefined (`packages/browser/src/create-analytics.ts:44-45`). **But note the shape difference:** `NoopAdapter` implements the seam's `AnalyticsAdapter` interface — node is a standalone client (shape A) with its OWN narrower `NodeAnalytics` interface, so `NoopAdapter` does NOT type-fit node's client surface. Node needs its OWN null-object client (`NodeNoop implements NodeAnalytics`) whose methods are all no-ops and whose `flush`/`shutdown` resolve immediately. Reuse only the null-object PATTERN, not the `NoopAdapter` class.
- **flush / shutdown** — posthog-source-guide (2026-07-08): `shutdown(timeoutMs = 30000)` clears the flush timer, awaits in-flight prep, then LOOPS `flush()` until the queue is empty (catching mid-drain enqueues), all inside a `Promise.race` against the timeout that breaks the drain and rejects "Some events may not have been sent" (`posthog-core-stateless.ts:1512-1568`). Port de-branded: make `shutdownTimeoutMs` config-driven (posthog's default is 30000ms — a reasonable R1 default). Whether shutdown-timeout REJECTS or resolves-with-warning is a builder call; the reference rejects — either is acceptable as long as the process is not left hung and the behavior is documented.
- The browser's `shutdown()` (`packages/browser/src/browser-adapter.ts:826-833`) unbinds listeners then flushes — node has no listeners to unbind (no beacon/unload); node's `shutdown()` is queue-drain + timer-clear + quiesce.
- **Coordination:** `shutdownTimeoutMs?` is a `NodeAnalyticsConfig` field (added to the config shape in E7-S2); this story reads it with a sane default (30000ms, per the ported reference). The "timer-clear" quiesce clears the E7-S3 queue's armed `setTimeout` handle (`NodeJS.Timeout` / `ReturnType<typeof setTimeout>`) so no post-shutdown interval trigger re-arms delivery — S3 owns arming/clearing the handle; S6 drives the final clear. The `@types/node` devDep (E7-S2) types both.
- **`flush()` on the no-op client** resolves immediately (the `NodeNoop` route), same as on the real client with an empty buffer — a consumer calling `flush()`/`shutdown()` in an unkeyed environment never blocks.
- **Frozen-15 pin:** `flush`/`shutdown` are shared verb NAMES with the seam facade, but node exposes them on its own narrower client, not by implementing `AnalyticsProvider`. Pin untouched.
- api_impact additive.

## Shipped
- > Reviewer suggestion (2026-07-08, doc): AC-3 "re-flushes to catch events enqueued during the drain" splits into two cases — (a) a CONSUMER capture racing mid-shutdown is intentionally INERT (`stopped`-at-top = "no new work once shutdown starts"), (b) QUEUE-INTERNAL residue landing during a `flushNow` in-flight await IS swept by the next loop iteration (proven at the queue seam). The reference's loop sweeps case (b), not (a) — inert-consumer is strictly safer, not an AC violation. Note both cases so a future reader doesn't misread.
- > Reviewer note (2026-07-08): resolve-not-reject on shutdown timeout (+ `console.error`) is the sound choice for a `shutdown(): Promise<void>` awaited in a SIGTERM handler (a rejecting shutdown is an unhandled-rejection footgun) — a PostHog-anchored deviation, correctly justified. AC only needs "settles deterministically / not hung."
- > Reviewer note (2026-07-08, precision): the story note "flush/shutdown are shared verb NAMES with the seam facade" understates it — `flush`/`shutdown` ARE members of the seam's `AnalyticsProvider` frozen-15. The pin claim still holds: seam untouched, node does NOT implement `AnalyticsProvider` (own narrower `NodeAnalytics`).
- > E10 watch-items (2026-07-08): (1) node `NodeAnalytics` (`capture`/`setTraits`/`setGroupTraits`/`flush`/`shutdown`) is intentionally narrower + differently-named than the seam facade (`track`/`identify`/`group`…) — E10 must show browser+node as SIBLINGS, not a unified client. (2) the resolve-on-timeout `console.error` is the only shutdown-drop signal — E10's shutdown wiring should await `shutdown()` in the signal handler so the drain window is used.

## Shipped

> Captured by `implement-epics` on 2026-07-08. Closes E7 (the node target).

- **Files added (node):** `node-noop.ts` (`NodeNoop<TX>` null-object implementing narrow `NodeAnalytics` — every verb a silent no-op, never constructs queue/transport, `flush`/`shutdown` resolve immediately)
- **Files changed:** `create-analytics.ts` (factory selects `NodeNoop` when `config.key === undefined`, else real client — returns BEFORE `createSendBatch` so the transport is provably never built), `node-analytics.ts` (real `flush()`=`queue.flushNow()`; `shutdown()`=`stopped`-at-top + loop-drain `while(queue.size>0) await flushNow()` raced against configurable `shutdownTimeoutMs` default 30000 via `Promise.race`, resolve+`console.error` on timeout, `queue.drain()` clears timers; all 3 verbs guard `if(this.stopped) return`), `batch-queue.ts` (+`get size()` pure read-only — honest buffered count, NOT a client shadow counter; queue stays a pure buffer)
- **New public API:** node `flush()`/`shutdown()` real bodies (verb names shared with seam facade but on node's OWN narrower client — seam-15 UNTOUCHED). Unkeyed⇒`NodeNoop`.
- **Tests added:** node +19 (create-analytics: keyed→real/unkeyed→NodeNoop, unkeyed all-3-verbs-never-send bar B, unkeyed off-list-doesn't-throw gate-skipped, unkeyed flush/shutdown resolve; node-analytics: flush force-drains-before-interval + resolves-on-settle + stays-usable, shutdown drains-all + mid-drain-consumer-inert + empty-resolves + timeout-deterministic-not-hung + configurable + post-shutdown-inert-no-rearm + double-shutdown-noop; batch-queue: get size() + refill-during-in-flight-caught) → 117; seam 166 unchanged
- **Commit:** `E7-S6-noop-and-lifecycle — No-op-without-key + flush/shutdown lifecycle` on `core-cycle`
- **Reviewer notes:** 0 critical, 3 doc/assessment suggestions; E7-close-ready (node target coherent, both bars held)
