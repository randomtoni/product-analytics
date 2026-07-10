---
id: E14-S4-snapshot-buffering-delivery-masking
epic: E14-SR-session-replay
status: ready-for-dev
area: session-replay
touches: [browser]
depends_on: [E14-S3]
api_impact: additive
---

# E14-S4-snapshot-buffering-delivery-masking — Snapshot buffering + delivery + masking

## Why

S2/S3 stood up the recorder and its session linkage; this story delivers the snapshots. Replay data is high-volume, size-sensitive `$snapshot` payloads — batching them through the capture queue (tuned for small events) is wrong on both axes — so the recorder gets its own buffer + flush cadence, reusing the adapter's neutral `fetch`/gzip primitives but with its own delivery policy. It also owns the three browser-lifecycle behaviors the capture queue does not provide (size-triggered flush, flush-on-teardown, the sampling flush-guard) and applies the S1 masking config to the recorder.

## Scope

### In

- **A separate replay delivery path** (adapter-internal, in the S2 replay module) — its own buffer of rrweb events + its own flush policy, reusing the neutral primitives (the adapter's `fetch` seam, `gzip` — `gzip.ts`/`transport.ts`) but NOT the capture batch queue. Posts to the configured ingest path: **reuse `config.ingestHost` + a fixed replay path** (epic Notes → Open questions, CLOSED); no separate replay-endpoint config field.
- **Size-triggered flush** — a single large DOM snapshot flushes on its own, independent of an event-count/time batch (mirror the reference `RECORDING_MAX_EVENT_SIZE` size-trigger).
- **Flush-on-teardown** — the buffer flushes on `unload` / `visibilitychange` (hidden) / `stop()` / session rotation, so the final segment isn't lost. Browser-lifecycle-specific; does NOT come free from the capture queue.
- **The sampling flush-guard** — when `config.sessionReplay.sampleRate` gates a session: the keep/drop decision is made ONCE per session on `start` AND **re-made on session-id rotation** (using S3's rotation hook), persisted for the session's life, and the buffer **does NOT flush while the decision is pending** — otherwise a batch leaks for a session the recorder then drops. (Mirror the reference `makeSamplingDecisions` + the flush-guard.)
- **Apply the masking config to the recorder** — thread `config.sessionReplay.masking` (`maskAllInputs`/`maskTextSelector`/`blockSelector`) into the rrweb `record()` options so the DOM content channel is gated per the consumer's policy. Default `maskAllInputs: true` when masking is absent.

### Out

- **The port surface + config shape** — S1 (frozen). This story CONSUMES `config.sessionReplay.sampleRate`/`.masking`, it does not define them.
- **Session linkage + the rotation-detection mechanism** — S3. This story CONSUMES S3's rotation hook (for re-decide-on-rotation + flush-on-rotation); it does not re-implement rotation detection.
- **A real-backend end-to-end delivery probe** — S5's proof territory / the ROADMAP development prerequisite (an ingest key that accepts `$snapshot`). This story's delivery path is unit-provable against a mock/loopback fetch seam (the PY8 precedent: unit tests need no live key; the end-to-end probe does).
- **Canvas capture, network-payload capture, min/max-duration, runtime lazy-load** — epic Out of scope (deferred rrweb plugins / optimization).
- **A separate replay-endpoint HOST config field** — CLOSED (epic Notes): reuse `ingestHost` + fixed path; a separate host is a knob with no driver, additive later.

## Acceptance criteria

- [ ] Replay snapshots deliver via a SEPARATE path (own buffer + flush policy) reusing the adapter's `fetch`/gzip primitives — NOT the capture batch queue. A large snapshot triggers a size-based flush independent of the event-count/time batch.
- [ ] The buffer flushes on `unload`, `visibilitychange` (hidden), `stop()`, and session rotation — a test proves the final segment is delivered on each teardown trigger (not lost).
- [ ] The sampling decision is made once on `start` and RE-made on rotation (via S3's rotation hook); the buffer does NOT flush while the decision is pending — a test proves no batch leaks for a session that is then decided to drop (decide-before-flush ordering).
- [ ] `config.sessionReplay.masking` is threaded into the recorder: `maskAllInputs` (default `true` when masking absent), `maskTextSelector`, `blockSelector` gate DOM content — a test asserts input values are masked by default and a selector opt-in/block behaves.
- [ ] Delivery posts to `config.ingestHost` + the fixed replay path (no separate replay-host config); `$snapshot` + the wire shape stay in `[WIRE]`/adapter-internal consts — zero vendor references on any observable surface.
- [ ] Gates green: `cd ts && pnpm turbo run build test typecheck lint` + `pnpm neutrality-scan`. No test hits a live backend (mock/loopback fetch seam).

## Technical notes

- **Replay uses a SEPARATE delivery path, not the capture batch queue** — architect-locked (epic Notes → "Transport", 2026-07-10). Replay snapshots are high-volume, high-frequency, size-sensitive `$snapshot` payloads; batching a 50KB DOM snapshot through the queue tuned for small events (`flushAt`/`flushInterval`) is wrong on both axes. The recorder buffers rrweb events and posts on its own cadence — reusing the neutral primitives (the adapter's `fetch` seam, gzip, the offline-queue PATTERN) but with its own buffer + flush policy. Fully adapter-internal; no transport concept reaches the port.
- **The separate path owns three lifecycle behaviors the capture queue does not** — architect-locked (epic Notes → "Transport", epic-refine 2026-07-10): (1) size-triggered flush (reference `RECORDING_MAX_EVENT_SIZE`), (2) flush-on-teardown (`beforeunload`/`visibilitychange`/`offline`/`online` in the reference), (3) the sampling flush-guard (no flush while the per-session sampling decision is pending). These are the delivery half of the two new lifecycle success criteria; S4 owns them.
- **Sampling decision: decide-before-flush + re-decide-on-rotation** — architect-locked (epic Notes → success criteria, 2026-07-10). The keep/drop decision is made ONCE per session on `start`, re-made on rotation (S3's hook), persisted for the session's life; the buffer does NOT flush while pending — otherwise a batch leaks for a session then dropped. This ordering is a CORRECTNESS criterion, not a detail (mirrors reference `makeSamplingDecisions` + the flush-guard).
- **Ingest path: reuse `ingestHost` + fixed replay path** — architect-locked (epic Notes → Open questions, CLOSED med-high, 2026-07-10). PostHog sends `$snapshot` to the same ingestion HOST, differentiated by PATH, not a separate host — reuse-with-fixed-path matches that and avoids a second config knob (helps bar B). **Note the distinction: the HOST is shared with capture; the DELIVERY PATH (buffer, compression, size-trigger, flush cadence) stays SEPARATE from the capture batch queue.**
- **Masking = the NEW privacy surface** — architect-locked (epic Notes → "Config vs port; privacy masking"). Gates DOM content (`maskAllInputs`/mask-text-selector/block-selector), orthogonal to the E3/E4 allowlist (which gates event property keys). Default `maskAllInputs: true`. Thread into rrweb `record()` options behind the adapter — the rrweb option names never reach the neutral surface (S1's neutral config field names map to them internally).
- **De-brand reference:** `posthog-js/packages/browser/src/extensions/replay/session-recording.ts` — `RECORDING_MAX_EVENT_SIZE` (size-trigger), the `beforeunload`/`visibilitychange`/`offline`/`online` teardown flush, `makeSamplingDecisions`, the sampling-gated `_flushBuffer`, and how masking options are passed to `record()`. Adapt de-branded (drop `$snapshot`/wire vocab into `[WIRE]` consts). Consult `posthog-source-guide` for the exact size-trigger + flush-guard mechanics if the source is unclear.
- **Reuse the existing neutral primitives:** `gzip.ts` (`gzipCompress`/`gzipSyncFallback`), `transport.ts` (`beaconSend`/`postViaXhr`/`hasFetch`/`KEEPALIVE_THRESHOLD_BYTES`), and the offline-queue PATTERN — the browser adapter already imports these (`browser-adapter.ts:55–57`). The replay path reuses the primitives, not the capture queue's buffer.
- **The end-to-end delivery PROBE (live ingest key) is S5 / the dev prerequisite** — this story's buffer/flush/masking/sampling logic is unit-provable against a mock fetch seam (PY8 precedent). Do NOT gate this story on a live key.
- No architect consult needed — every decision above is pre-resolved in the epic `## Notes`.

## Shipped
