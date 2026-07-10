---
id: E14-SR-session-replay
status: active
area: session-replay
touches: [browser, core, react]
api_impact: additive
blocked_by: []
updated: 2026-07-10
---

# E14-SR-session-replay — Session replay (browser-only, TS)

## Why

Session replay is the second declared-but-unimplemented port the seam left as a stub
(`SessionReplayPort` — TS `ts/packages/analytics-kit/src/ports.ts:8`, `replay?` on the provider). It
records DOM mutations so a consumer can watch a real session play back, stitched to the same distinct
id + session id its captured events carry. It is **browser-shaped and TS-only in practice** — a
server-shaped client has no DOM to record — so it advances a narrower slice than feature-flags and
**sequences after E12/E13**. The Python target gets an explicit **N-A-BY-PLATFORM** disposition (its
slot stays `None` permanently — a final, documented platform boundary, not a pending gap). Finishing
the port is purely additive: `replay?` is already an optional member of `AnalyticsProvider`
(`analytics-provider.ts:56`), so no frozen-15 pin is disturbed. Architect-consulted against the
`posthog-js` checkout (2026-07-10).

## Success criteria

- The neutral `SessionReplayPort` is finished as a small control surface: `start(): void`,
  `stop(): void`, `isActive(): boolean`, `getReplayId(): string | undefined`. Each has a direct
  `posthog-js` public-API analog (`startSessionRecording`/`stopSessionRecording`/
  `sessionRecordingStarted`/`get_session_id`) and **zero rrweb/vendor vocabulary**. `start` is
  idempotent; `getReplayId` returns the neutral session-linkage id (NOT a vendor console URL — see
  Notes) or `undefined` when inactive.
- **rrweb lives entirely behind the browser adapter.** The neutral port names no rrweb; the recorder +
  the `rrweb` import live in a replay module of `@analytics-kit/browser`, the way transport/persistence
  already hide their internals. The dependency is **upstream `rrweb` (`rrweb-io/rrweb`, MIT), NOT
  `@posthog/rrweb-*`** — the vendor-named fork would put a `posthog` token in the lockfile. The neutral
  surface stays rrweb-free and vendor-free.
- **Replay is a separately-importable entrypoint** of `@analytics-kit/browser` (its own tsup entry), so
  a consumer who never enables replay does not bundle rrweb (~100KB+). Getting this entry boundary right
  is load-bearing (changing it later is breaking); runtime dynamic `import()` of the chunk is a deferred
  optimization.
- **Adoption is config-only (bar B):** `AnalyticsConfig.sessionReplay?: { enabled; sampleRate?;
  masking? }` — enabling replay, sampling (0–1, boundary-validated), and privacy masking are all init
  config, not port methods. The default is **privacy-forward**: `maskAllInputs: true` (record structure,
  mask input values unless a selector opts back in).
- **Replay masking is a NEW, orthogonal privacy surface that composes with the E3/E4 allowlist — it does
  not extend it.** The allowlist gates *event property keys*; replay masking gates *DOM content* (which
  inputs/text/elements rrweb serializes). Two channels, two policies, both consumer-owned — consistent
  with the BRIEF's "consumer supplies the policy, library enforces" principle, distinct mechanism.
- **Session/event linkage:** the recorder reads the **same** `SessionIdManager`
  (`session-id-manager.ts`) the capture path uses — it does NOT mint its own id — so the recording and
  the events stitch on one session id. On session-id **rotation** (idle/max-length expiry mid-recording)
  the recording re-keys to the new id. `getReplayId()` exposes that id as an opaque neutral string
  (never the persisted tuple, storage key, or a `/replay/{id}` URL).
- **The linkage is reachable by the capture enrichment path, not just readable via `getReplayId()`.**
  In the reference, the replay id is what stitches a session's captured *events* to its recording; a
  read-only `getReplayId()` that nothing propagates would leave events and recording unjoined. Because
  the browser target already owns `SessionIdManager` and stamps `NeutralEvent.sessionId` on every event
  (E4-S8), that shared session id **is** the join key — this criterion makes it explicit that the
  recording and the captured events resolve to the same session id at enrichment time, so replay and
  events join on the backend. — architect (2026-07-10, epic-refine).
- **Sampling decision is made before any flush and re-made on rotation.** When `sampleRate` gates a
  session, the keep/drop decision is made **once per session on `start`** (and **re-made on session-id
  rotation**), persisted for the session's life, and the snapshot buffer **does not flush while the
  decision is pending** — otherwise a batch leaks for a session the recorder then decides to drop. This
  decide-before-flush / re-decide-on-rotation ordering is a correctness criterion, not a detail
  (mirrors the reference `makeSamplingDecisions` + the flush-guard). — architect (2026-07-10).
- **In-flight replay data flushes on page teardown.** The recorder flushes its snapshot buffer on
  unload / visibility-hidden / `stop` / rotation, so the final segment of a session is not lost. This is
  browser-lifecycle-specific and does NOT come for free from the capture queue (replay uses a separate
  delivery path — see Transport). — architect (2026-07-10).
- **Bar A:** a consumer swaps to a mock replay adapter (or a future non-vendor replay backend) with
  zero consumer change — the one `SessionReplayPort` is satisfied by each adapter.
- The React binding exposes replay control through the provider (`provider.replay`), taxonomy-agnostic
  (replay carries no props taxonomy).
- **Python: `SessionReplayPort` is N-A-BY-PLATFORM** — the slot stays `None` permanently, recorded in
  the parity matrix as a final platform boundary (browser-only DOM recording; server has no analog),
  the same row treatment as `page`/`reset`/the browser transport, with a one-line rationale — never a
  silent omission.
- Zero vendor references on any surface: the `$snapshot` event type, the rrweb `eventWithTime` payload
  shape, the replay ingest path, and any console-URL template are `[WIRE]`/adapter-internal
  (`$`-const). `rrweb` in `package.json` deps is not a `posthog` token — confirmed the neutrality-scan
  name-check (`ts/scripts/neutrality-scan.ts:226`) does not flag it; verify at the S2 dep-add anyway.

## Development prerequisites

- **A live analytics project + ingest key that accepts session-recording (`$snapshot`) payloads** to
  prove replay snapshots actually deliver end-to-end (the PY8/R1 lesson: all-gates-green ≠ correct —
  a real-stack probe must exercise the real delivery path, not a self-consistent mock). Unit-level
  recorder/masking/linkage tests need no live key; the end-to-end delivery probe does. Mirrored in
  ROADMAP's `## Development prerequisites`.

## Stories

Drafted to `stories/2-ready-for-dev/` at `/implement-epics` time. Sequence is a linear chain (each
story builds on the prior): **S1 → S2 → S3 → S4 → S5**. `depends_on`: S1 `[]`, S2 `[S1]`, S3 `[S2]`,
S4 `[S3]`, S5 `[S4]`.

- **[E14-S1](../stories/2-ready-for-dev/E14-S1-neutral-replay-port-config-substrate.md)** *(additive, no deps)* — widen `SessionReplayPort` to `{ start, stop, isActive, getReplayId }` + add `AnalyticsConfig.sessionReplay?` (enabled/sampleRate 0–1/masking) with boundary validation; pure neutral seam, the bar-A/bar-B-defining story.
- **[E14-S2](../stories/2-ready-for-dev/E14-S2-recorder-rrweb-behind-adapter.md)** *(additive, depends on E14-S1)* — replay module in `@analytics-kit/browser` driving upstream MIT `rrweb` behind the adapter as a **separate entrypoint** (base import stays rrweb-free); wire `start/stop/isActive`, populate `provider.replay`, verify the neutrality-scan dep dimension.
- **[E14-S3](../stories/2-ready-for-dev/E14-S3-session-event-linkage-rekey.md)** *(additive, depends on E14-S2)* — recorder reads the shared `SessionIdManager` (no separate id), `getReplayId()` returns it, **re-key on rotation** reusing the adapter's existing rotation verdict — the epic's one hard correctness invariant.
- **[E14-S4](../stories/2-ready-for-dev/E14-S4-snapshot-buffering-delivery-masking.md)** *(additive, depends on E14-S3)* — own snapshot buffer + delivery path (reuse `ingestHost`+fixed path + the adapter `fetch`/gzip primitives, NOT the capture queue): size-triggered flush, flush-on-teardown, the sampling flush-guard (decide-before-flush + re-decide-on-rotation), and threading masking config into the recorder.
- **[E14-S5](../stories/2-ready-for-dev/E14-S5-example-proof-python-na-row.md)** *(additive, depends on E14-S4)* — Fernly enables replay by config alone + swaps to a mock replay adapter (bar A + bar B) + capability-presence pin; move the Python `replay` disposition from "declared slot, awaiting cycle" to **N-A-BY-PLATFORM (slot permanently `None`)** in the parity matrix + `provider.py` docstring. Real-stack `$snapshot` probe gated by the live-ingest-key dev prerequisite.

## Out of scope

- **Any Python replay implementation** — browser-only DOM recording; the Python slot is
  N-A-BY-PLATFORM (permanent), not a future cycle. Documented, not silently dropped.
- **`pause()`/`resume()`** — PostHog has no pause/resume on its public surface; "don't record this
  flow" is `stop()` then `start()`. No reference bar to build to; deferred until a concrete consumer
  need.
- **Sampling/linked-flag/url-trigger/event-trigger OVERRIDES** (`startSessionRecording({ sampling,
  linked_flag, url_trigger, … })`) — these override PostHog's *remote-config-driven* gating, and this
  library has no remote-config channel. Sampling is a **config** field; there is no remote gate to
  override. Deferred, declared-not-omitted.
- **Canvas capture, network-payload capture, min/max-duration** — advanced rrweb plugins (canvas is
  expensive; network capture is a privacy minefield capturing request/response bodies). Config fields
  that DEFER to a later hardening slice; not v1 capability-defining.
- **Runtime dynamic `import()` of the recorder chunk** — a bundle optimization on top of S2's entry
  boundary; deferred (the entry boundary is the load-bearing, non-breaking-later part).
- **Feature flags** — E12/E13.

## Notes

Every load-bearing decision below is architect-locked (2026-07-10) so stories don't re-litigate it.

### Neutral port surface

- **v1 port = `{ start, stop, isActive, getReplayId }`** — each with a direct `posthog-js` public-API
  analog (`posthog-core.ts:3152–3438`) and no rrweb vocabulary. `start` idempotent (a second call
  while active is a no-op, mirroring the `isStarted` guard). `stop` is load-bearing — a consumer must
  halt recording for a sensitive flow (checkout, PII form). `isActive` is the `sessionRecordingStarted`
  gate consumers branch on. — architect (2026-07-10).
- **`getReplayId` exposes the neutral session-linkage ID, NOT a vendor console URL.** PostHog exposes
  both `get_session_id()` (the raw id) and `get_session_replay_url()` (a PostHog-console route
  `/project/{token}/replay/{id}`). The URL is vendor-specific — **do NOT put `getReplayUrl()` on the
  neutral port** (it bakes in a PostHog console route). Expose the id; a consumer builds a URL from it
  if their backend has one. — architect (2026-07-10).

### rrweb behind the adapter (neutrality)

- **rrweb is general-purpose OSS (MIT), NOT a PostHog thing** — the de-facto SOTA DOM recorder used
  across the industry (PostHog, Highlight, OpenReplay). Its function surface (`record()`,
  `eventWithTime`, mutation/snapshot types) carries zero PostHog branding. So it is an **acceptable
  third-party dependency, not a vendor leak** — provided it lives behind the adapter and its types
  never reach the neutral port (exactly how the browser target already depends on cookies /
  `MutationObserver` without those leaking). — architect (2026-07-10).
- **Depend on upstream `rrweb` (`rrweb-io/rrweb`), NOT `@posthog/rrweb-*`.** The PostHog fork is a
  vendor-named package — pulling `@posthog/rrweb-record` into the dependency tree would put a `posthog`
  token in `package.json`/lockfile. Upstream is the neutral choice and is what the fork derives from.
  The neutrality-scan name-check reads each `package.json` name (`neutrality-scan.ts:226`) but does not
  scan the `dependencies` list for tokens — `rrweb` is safe; **verify at the S2 dep-add**. —
  architect (2026-07-10).
- **Entry-separation is load-bearing; runtime lazy-load is deferred.** PostHog lazy-loads the recorder
  from a CDN for (a) bundle size and (b) remote-config-gated script naming. (b) does not apply (no
  remote config). (a) does — rrweb is heavy, and a non-replay consumer shouldn't pay for it. Make the
  replay module a **separate entrypoint/subpath export** so importing the base browser target doesn't
  pull rrweb into the graph. Getting the entry boundary wrong later is breaking; deferring runtime
  `import()` is not. — architect (2026-07-10).

### Config vs port; privacy masking

- **How replay records = config (bar B); runtime control of an active recording = the four port
  verbs.** `enabled`, `sampleRate` (0–1, `isValidSampleRate`-mirrored at the Zod boundary), and
  `masking` are config; there is no per-call replay argument. Canvas/network/min-max-duration are
  config fields DEFERRED to a later slice. — architect (2026-07-10).
- **Replay masking is a NEW privacy surface, orthogonal to and composing with the E3/E4 allowlist — it
  does not extend it.** The allowlist gates *property keys on captured events* (a `Set<string>` over
  the structured `NeutralProperties` bag). Masking gates *DOM content* (`maskAllInputs`,
  mask-text-selector, block-selector — CSS/DOM concepts). They filter **different data channels** and
  cannot be unified. State it as: *"two channels, two policies, both consumer-owned."* Do NOT derive
  one from the other. **Default `maskAllInputs: true`** — privacy-safe by default (PostHog's more
  permissive defaults rely on a remote config UI to tune, which this library does not have). —
  architect (2026-07-10).

### Session/event linkage

- **The session id already flows through the pipeline** — `SessionIdManager.checkAndGetSessionId` mints/
  extends it and the browser adapter stamps `NeutralEvent.sessionId` on every event (E4-S8). The
  linkage is: the recording is tagged with the **same** session id events carry (and to the user via
  `distinctId`). **The recorder reads the shared `SessionIdManager` — it does NOT mint its own id**;
  if it did, recording and events would not stitch. That is the one hard correctness invariant. —
  architect (2026-07-10).
- **Re-key on rotation is the one moving part.** Idle/max-length expiry mints a fresh session id
  mid-recording; the recorder must observe rotation and start a new recording segment against the new
  id, or stitching breaks across the rotation (PostHog handles this via `sessionManager.onSessionId`,
  `session-recording.ts:235`). This is load-bearing, not gold-plating — make it an explicit S3
  acceptance criterion. — architect (2026-07-10).

### Transport

- **Replay uses a SEPARATE delivery path, not the capture batch queue.** Replay snapshots are
  high-volume, high-frequency, size-sensitive `$snapshot` payloads; batching a 50KB DOM snapshot
  through the queue tuned for small events (`flushAt`/`flushInterval`) is wrong on both axes. The replay
  recorder buffers rrweb events and posts on its own cadence to a configured ingest path — **reusing the
  neutral primitives** (the adapter's `fetch` seam, gzip, the offline-queue *pattern*) but with its own
  buffer + flush policy. Fully adapter-internal; no transport concept reaches the port. —
  architect (2026-07-10).
- **The separate delivery path owns three lifecycle behaviors** the capture queue does not provide:
  (1) a **size-triggered flush** (a single large DOM snapshot flushes on its own, independent of an
  event-count/time batch), (2) **flush-on-teardown** (unload / visibility-hidden / `stop` / rotation —
  so the last segment isn't lost), and (3) the **sampling flush-guard** (no flush while the per-session
  sampling decision is pending). These are the delivery half of the two new lifecycle success criteria
  above; S4 owns them. Grounded in the reference recorder (`RECORDING_MAX_EVENT_SIZE` size-trigger, the
  `beforeunload`/`visibilitychange`/`offline`/`online` teardown flush, and the sampling-gated
  `_flushBuffer`). — architect (2026-07-10, epic-refine).

### Python N-A treatment (the PY8 category distinction)

- PY8-S1 locked TWO N-A categories: **N-A-by-platform** ("server has no analog" — `page`/`reset`/browser
  transport) vs **declared-but-unimplemented-slot** ("`None`, awaiting a cycle" — where `replay` sits
  today). When this epic finishes TS replay, replay's Python disposition moves to
  **N-A-BY-PLATFORM (slot permanently `None`)** — a *stronger* statement than today's "declared slot
  awaiting a cycle," because after this epic there is no future Python cycle that fills it; the platform
  boundary is **final**, not pending. — architect (2026-07-10).
- The S5 recipe story carries this as an explicit deliverable: move the `replay` row in the parity
  matrix + `python/src/analytics_kit/provider.py` docstring, with a one-line rationale ("Session replay
  records DOM mutations (rrweb) in a browser; a server-shaped client has no DOM to record. Documented
  platform omission, not a silent gap.") — the same vocabulary the parity audit already uses for
  browser-only rows.

### Open questions (closed at epic-refine — kept as decision record)

- **Replay ingest path config — CLOSED, reuse `ingestHost` + fixed replay path** (med-high). PostHog
  sends `$snapshot` events to the same ingestion host, differentiated by path, not a separate host —
  reuse-with-fixed-path matches that and avoids a second config knob (helps bar B: config-only
  adoption). **Rejected** a separate replay-endpoint config field for v1 — a knob with no driver;
  additive later if a consumer need lands. Note the distinction: the **host** is shared with capture,
  but the **delivery path** (buffer, compression, size-trigger, flush cadence) stays separate from the
  capture batch queue — see Transport. — architect (2026-07-10).

## Expansion path

- A future non-vendor replay backend is **one new adapter, zero consumer change** — it satisfies the
  same `SessionReplayPort` and maps the buffered recording to its own wire. Because rrweb sits behind
  the adapter, a backend using a different recorder is still one adapter swap.
- Deferred surface (canvas capture, network-payload capture, min/max-duration, runtime lazy-load,
  pause/resume) extends additively behind the same port/config later, if a consumer need lands.
