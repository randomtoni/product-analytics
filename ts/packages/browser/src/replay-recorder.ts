import type { AnalyticsProvider, SessionReplayConfig, SessionReplayPort } from 'analytics-kit';
import { BrowserAdapter } from './browser-adapter';
import { resolveReplayIngestUrl } from './ingest-url';
import type { ReplayEvent, ReplayMaskingOptions, ReplayRecordingHandle } from './replay';
import { createReplayDelivery, type ReplayDelivery } from './replay-transport';
import { decideSampled, normalizeSampleRate } from './replay-sampling';

// How often the recorder checks its live buffer to decide whether a size-triggered flush is
// due (the reference arms a short fallback timer per buffered event; a fixed poll is the
// simpler base-safe equivalent and also serves as the time-based flush fallback).
const FLUSH_POLL_INTERVAL_MS = 2000;

// Size-triggered flush threshold: a buffer whose encoded size crosses this flushes on its
// own, independent of the poll cadence (de-branded from the reference RECORDING_MAX_EVENT_SIZE
// ~0.9 MB). A single large DOM snapshot ships promptly rather than waiting for the timer.
const FLUSH_SIZE_THRESHOLD_BYTES = 0.9 * 1024 * 1024;

export interface ReplayRecorderOptions {
  // The current session-linkage id, single-sourced through the adapter (never minted here —
  // mirrors how the flag adapter takes `getDistinctId`). A PURE read: `getReplayId` may be
  // called arbitrarily by a consumer, so it must not advance session state.
  getSessionId: () => string | undefined;
  // Subscribe to session-id rotation, priming with the current id on subscribe and firing on
  // every subsequent rotation; returns an unsubscribe closure. The recorder re-keys its
  // recording (stop + start against the new id) on rotation so a recording never spans two
  // session ids. Optional so the recorder degrades to a single non-re-keying segment when
  // absent (e.g. an id source with no rotation signal). Adapter-internal — the neutral port
  // exposes no rotation concept.
  // The listener's `sessionId` is `undefined` ONLY on the subscribe-time PRIME (no session yet);
  // a genuine ROTATION notification always carries a DEFINED id (`classifySessionTransition`
  // never yields `'rotated'` for an `undefined` id), so no recording segment ever keys onto
  // `undefined`.
  onRotate?: (listener: (sessionId: string | undefined) => void) => () => void;
  // The DOM-content masking policy threaded into rrweb's `record()` behind the body (E14-S4).
  // Neutral field names (from `config.sessionReplay.masking`); the body maps them onto rrweb's
  // option names. Absent ⇒ the privacy-safe default (`maskAllInputs: true`).
  masking?: ReplayMaskingOptions;
  // The consumer's raw `sampleRate` (E14-S4). Normalized here at construction (finite-in-[0,1]
  // → use; else → record-all with a dev warn; never throws) — the seam left it an unvalidated
  // type carrier, the normalization lives next to the sampling machinery.
  sampleRate?: number;
  // The replay delivery sink (own buffer/flush → gzip → POST to the replay ingest URL, SEPARATE
  // from the capture queue). Injected so the recorder stays testable against a mock sink.
  delivery: ReplayDelivery;
}

// The neutral session-replay recorder — the browser impl of `SessionReplayPort`. It is the
// rrweb-free SHELL of the recorder: it holds the started guard, the recording handle, the id
// source, the sampling decision, and its OWN delivery/flush policy, but reaches the heavy rrweb
// body ONLY through a dynamic `import('./replay')` inside the recording start. That dynamic
// boundary is what keeps rrweb out of the base `dist/index.*` bundle (esbuild code-splits it into
// `dist/replay.*`) while `attachReplay` stays synchronous so `provider.replay` is populated at
// construction, mirroring `provider.flags`. The delivery/gzip/transport primitives it uses are
// base-safe (the capture path already imports them), so wiring them here does NOT pull rrweb in.
export class ReplayRecorder implements SessionReplayPort {
  private readonly getSessionId: () => string | undefined;
  private readonly onRotate:
    | ((listener: (sessionId: string | undefined) => void) => () => void)
    | undefined;
  private readonly masking: ReplayMaskingOptions | undefined;
  private readonly sampleRate: number;
  private readonly delivery: ReplayDelivery;
  // Whether a recording is running. Set true synchronously on `start()` (before the rrweb
  // body resolves) so a second `start()` is a no-op; cleared on `stop()`. Reset to false if
  // the async rrweb load fails to initialize.
  private started = false;
  // The live rrweb recording handle (stop fn + snapshot buffer), resolved a tick after a
  // recording start once the replay chunk loads. undefined before it resolves and after
  // `stop()`.
  private handle: ReplayRecordingHandle | undefined;
  // The session id the LIVE recording segment is keyed to. Set when a segment starts (from
  // the id the rotation prime/notification carried); compared against a rotation
  // notification to decide whether to re-key. undefined while inactive.
  private keyedSessionId: string | undefined;
  // The per-session sampling verdict: true ⇒ record + flush, false ⇒ sampled-out (record
  // nothing), undefined ⇒ PENDING (no session id yet). Decided on `start`, re-decided on
  // rotation; the buffer does NOT flush while this is anything but `true` — the flush-guard.
  private sampled: boolean | undefined;
  // Monotonic per-segment token. Bumped each time a segment starts; the async rrweb load
  // captures the token at dispatch and discards its resolved handle if a newer segment (a
  // re-key) or a `stop()` superseded it meanwhile — unambiguous even if session ids repeat.
  private segmentToken = 0;
  // Disposes the rotation subscription; set on `start()`, called + cleared on `stop()`.
  private unsubscribeRotation: (() => void) | undefined;
  // Removes the pagehide/visibilitychange teardown listeners bound on `start()`; undefined
  // in a non-DOM (SSR/test) context where none were bound.
  private detachLifecycleListeners: (() => void) | undefined;
  // The size-poll timer that periodically checks the buffer for a size-triggered / time-based
  // flush; cleared on `stop()` and on re-key (a fresh segment re-arms it).
  private flushTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: ReplayRecorderOptions) {
    this.getSessionId = options.getSessionId;
    this.onRotate = options.onRotate;
    this.masking = options.masking;
    this.sampleRate = normalizeSampleRate(options.sampleRate);
    this.delivery = options.delivery;
  }

  // Begin recording (idempotent: a second call while active is a no-op, mirroring the
  // reference `isStarted` guard). The guard flips synchronously so `isActive()` reports
  // true immediately; the actual rrweb `record()` starts once the dynamically-imported
  // replay chunk resolves. The sampling decision is made HERE (once per session) before any
  // flush; subscribing to rotation primes the listener with the current id synchronously —
  // that primed id keys the first segment — then re-keys + re-decides on every later rotation.
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.keyedSessionId = this.getSessionId();
    this.sampled = decideSampled(this.keyedSessionId, this.sampleRate);
    this.beginSegment();
    this.bindLifecycleListeners();
    this.armFlushTimer();
    this.unsubscribeRotation = this.onRotate?.((sessionId) => {
      this.handleRotation(sessionId);
    });
  }

  // Halt recording: flush the final segment (teardown flush — the last segment isn't lost),
  // stop the live rrweb recording, unbind the teardown listeners + flush timer, drop the
  // rotation subscription, and clear the guard. Safe to call before a pending load resolves.
  stop(): void {
    this.flushBuffer(true);
    this.unsubscribeRotation?.();
    this.unsubscribeRotation = undefined;
    this.detachLifecycleListeners?.();
    this.detachLifecycleListeners = undefined;
    this.clearFlushTimer();
    this.handle?.stop();
    this.handle = undefined;
    this.keyedSessionId = undefined;
    this.sampled = undefined;
    this.started = false;
  }

  isActive(): boolean {
    return this.started;
  }

  // The neutral session-linkage id, read straight from the injected source — the SAME shared
  // session id captured events carry (single-sourced through the adapter's `SessionIdManager`,
  // never minted here), so the recording and the events stitch on one id. Reflects the new id
  // immediately after a rotation re-keys the recording.
  getReplayId(): string | undefined {
    return this.getSessionId();
  }

  // Re-key the live recording onto a rotated session id: FLUSH the current segment (so a
  // rotation cleanly bounds a segment and nothing is lost), end it, RE-DECIDE sampling for the
  // new session, and start a fresh segment. Ignores the subscribe-time prime and any
  // notification for the id the current segment is already keyed to. A no-op when inactive.
  private handleRotation(sessionId: string | undefined): void {
    if (!this.started || sessionId === this.keyedSessionId) {
      return;
    }
    this.flushBuffer(false);
    this.handle?.stop();
    this.handle = undefined;
    this.keyedSessionId = sessionId;
    this.sampled = decideSampled(sessionId, this.sampleRate);
    this.beginSegment();
  }

  // Load the rrweb chunk and begin an rrweb recording for the current segment, threading the
  // masking policy into `record()`. A `stop()` (or a re-key) racing the pending load is
  // honored — the resolved handle is discarded if the guard was cleared or a newer segment
  // started meanwhile. rrweb failing to initialize clears the guard so `isActive()` stays honest.
  private beginSegment(): void {
    const token = ++this.segmentToken;
    void import('./replay').then(({ startRecording }) => {
      if (!this.started || token !== this.segmentToken) {
        return;
      }
      const handle = startRecording(this.masking);
      if (handle === undefined) {
        this.started = false;
        return;
      }
      this.handle = handle;
    });
  }

  // Drain the live buffer and deliver it as one segment, tagged with the CURRENT session id
  // (getReplayId) so the snapshots stitch to their session. The flush-guard: it delivers ONLY
  // when the sampling decision is `true` — a pending (`undefined`) or sampled-out (`false`)
  // decision drains nothing, so no batch ever leaks for a session the recorder then drops.
  // `keepalive` marks a teardown flush (forces the beacon path so the closing page still
  // delivers). Draining `buffer.length = 0` keeps the live rrweb buffer growing from empty.
  private flushBuffer(keepalive: boolean): void {
    const buffer = this.handle?.buffer;
    if (buffer === undefined || buffer.length === 0) {
      return;
    }
    if (this.sampled !== true) {
      return;
    }
    const events: ReplayEvent[] = buffer.splice(0, buffer.length);
    this.delivery.send(events, this.getSessionId(), keepalive);
  }

  // Arm the periodic flush poll (also the time-based fallback flush): each tick ships any
  // accumulated segment, and a buffer already over the size threshold flushes on the same
  // tick. Both honor the sampling flush-guard inside flushBuffer.
  private armFlushTimer(): void {
    if (typeof setInterval === 'undefined') {
      return;
    }
    this.flushTimer = setInterval(() => {
      this.checkSizeTrigger();
      this.flushBuffer(false);
    }, FLUSH_POLL_INTERVAL_MS);
  }

  // Size-triggered flush: a buffer whose encoded size crosses the threshold flushes on its
  // own, independent of the poll cadence — a single large DOM snapshot ships promptly. A
  // buffer under the threshold is left to accumulate (the poll ships it on its tick).
  /** @internal Public only so a unit test can drive the size-trigger without waiting on the
   * poll interval; not stable adapter API. */
  checkSizeTrigger(): void {
    const buffer = this.handle?.buffer;
    if (buffer === undefined || buffer.length === 0) {
      return;
    }
    if (this.encodedSize(buffer) >= FLUSH_SIZE_THRESHOLD_BYTES) {
      this.flushBuffer(false);
    }
  }

  private encodedSize(buffer: ReplayEvent[]): number {
    return JSON.stringify(buffer).length;
  }

  private clearFlushTimer(): void {
    if (this.flushTimer !== undefined) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  // Bind the page-lifecycle events that signal a close/navigation so the final segment is
  // beacon-flushed before teardown (SSR-guarded; torn down on stop). The recorder owns its
  // OWN listeners — the adapter's teardown path is behind a private one-shot latch, and
  // teardown (unlike the rotation verdict) is NOT single-source-locked, so per-module
  // listeners are correct. visibilitychange(hidden) + pagehide are the bfcache-safe triggers.
  private bindLifecycleListeners(): void {
    const win = typeof window === 'undefined' ? undefined : window;
    const doc = typeof document === 'undefined' ? undefined : document;
    if (win === undefined) {
      return;
    }
    const onPageHide = (): void => this.flushBuffer(true);
    const onVisibilityChange = (): void => {
      if (doc?.visibilityState === 'hidden') {
        this.flushBuffer(true);
      }
    };
    win.addEventListener('pagehide', onPageHide);
    doc?.addEventListener('visibilitychange', onVisibilityChange);
    this.detachLifecycleListeners = () => {
      win.removeEventListener('pagehide', onPageHide);
      doc?.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }
}

// Attach the browser recorder to the provider's `replay` slot when replay is enabled by
// config AND the client is keyed (a BrowserAdapter, the only case a session id exists to
// source). Disabled/absent config or an unkeyed client (NoopAdapter) leaves the slot
// `undefined` — bar B, config-only adoption. Synchronous, mirroring `attachFlags`: it fills
// the existing optional `replay?` member, leaving the frozen provider keyof pin untouched.
// The recorder shell is rrweb-free, so importing THIS module into the base graph does not
// pull rrweb into `dist/index.*` — only the shell's dynamic `import('./replay')` reaches it.
// `config` threads the masking + sampleRate + the shared `ingestHost` (the replay path reuses
// capture's host + a fixed [WIRE] replay path) into the recorder's delivery/masking/sampling.
export function attachReplay(
  analytics: AnalyticsProvider,
  adapter: unknown,
  config: { ingestHost?: string; compression?: boolean; sessionReplay?: SessionReplayConfig }
): void {
  if (!(adapter instanceof BrowserAdapter)) {
    return;
  }
  analytics.replay = new ReplayRecorder({
    getSessionId: () => adapter.getReplaySessionId(),
    onRotate: (listener) => adapter.onSessionRotated(listener),
    masking: config.sessionReplay?.masking,
    sampleRate: config.sessionReplay?.sampleRate,
    delivery: createReplayDelivery(resolveReplayIngestUrl(config.ingestHost), config.compression),
  });
}
