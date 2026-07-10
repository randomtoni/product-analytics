import type { AnalyticsProvider, SessionReplayPort } from 'analytics-kit';
import { BrowserAdapter } from './browser-adapter';
import type { ReplayRecordingHandle } from './replay';

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
  onRotate?: (listener: (sessionId: string | undefined) => void) => () => void;
}

// The neutral session-replay recorder — the browser impl of `SessionReplayPort`. It is the
// rrweb-free SHELL of the recorder: it holds the started guard, the recording handle, and
// the id source, but reaches the heavy rrweb body ONLY through a dynamic `import('./replay')`
// inside the recording start. That dynamic boundary is what keeps rrweb out of the base
// `dist/index.*` bundle (esbuild code-splits it into `dist/replay.*`) while `attachReplay`
// stays synchronous so `provider.replay` is populated at construction, mirroring
// `provider.flags`.
export class ReplayRecorder implements SessionReplayPort {
  private readonly getSessionId: () => string | undefined;
  private readonly onRotate:
    | ((listener: (sessionId: string | undefined) => void) => () => void)
    | undefined;
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
  // Monotonic per-segment token. Bumped each time a segment starts; the async rrweb load
  // captures the token at dispatch and discards its resolved handle if a newer segment (a
  // re-key) or a `stop()` superseded it meanwhile — unambiguous even if session ids repeat.
  private segmentToken = 0;
  // Disposes the rotation subscription; set on `start()`, called + cleared on `stop()`.
  private unsubscribeRotation: (() => void) | undefined;

  constructor(options: ReplayRecorderOptions) {
    this.getSessionId = options.getSessionId;
    this.onRotate = options.onRotate;
  }

  // Begin recording (idempotent: a second call while active is a no-op, mirroring the
  // reference `isStarted` guard). The guard flips synchronously so `isActive()` reports
  // true immediately; the actual rrweb `record()` starts once the dynamically-imported
  // replay chunk resolves. Subscribing to rotation primes the listener with the current id
  // synchronously — that primed id keys the first segment — then re-keys on every later
  // rotation so a recording never spans two session ids.
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.keyedSessionId = this.getSessionId();
    this.beginSegment();
    this.unsubscribeRotation = this.onRotate?.((sessionId) => {
      this.handleRotation(sessionId);
    });
  }

  // Halt recording: stop the live rrweb recording (if it resolved), drop the rotation
  // subscription, and clear the guard. Safe to call before a pending load resolves —
  // clearing the guard makes the resolved handle discard itself.
  stop(): void {
    this.unsubscribeRotation?.();
    this.unsubscribeRotation = undefined;
    this.handle?.stop();
    this.handle = undefined;
    this.keyedSessionId = undefined;
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

  // Re-key the live recording onto a rotated session id: end the current segment and start a
  // fresh one, so a single recording never spans two session ids. Ignores the subscribe-time
  // prime and any notification for the id the current segment is already keyed to (the guard
  // against re-keying on the first segment / a redundant fire). A no-op when inactive.
  private handleRotation(sessionId: string | undefined): void {
    if (!this.started || sessionId === this.keyedSessionId) {
      return;
    }
    this.handle?.stop();
    this.handle = undefined;
    this.keyedSessionId = sessionId;
    this.beginSegment();
  }

  // Load the rrweb chunk and begin an rrweb recording for the current segment. A `stop()` (or
  // a re-key) racing the pending load is honored — the resolved handle is discarded if the
  // guard was cleared or a newer segment started meanwhile. rrweb failing to initialize clears
  // the guard so `isActive()` stays honest.
  private beginSegment(): void {
    const token = ++this.segmentToken;
    void import('./replay').then(({ startRecording }) => {
      if (!this.started || token !== this.segmentToken) {
        return;
      }
      const handle = startRecording();
      if (handle === undefined) {
        this.started = false;
        return;
      }
      this.handle = handle;
    });
  }
}

// Attach the browser recorder to the provider's `replay` slot when replay is enabled by
// config AND the client is keyed (a BrowserAdapter, the only case a session id exists to
// source). Disabled/absent config or an unkeyed client (NoopAdapter) leaves the slot
// `undefined` — bar B, config-only adoption. Synchronous, mirroring `attachFlags`: it fills
// the existing optional `replay?` member, leaving the frozen provider keyof pin untouched.
// The recorder shell is rrweb-free, so importing THIS module into the base graph does not
// pull rrweb into `dist/index.*` — only the shell's dynamic `import('./replay')` reaches it.
export function attachReplay(analytics: AnalyticsProvider, adapter: unknown): void {
  if (!(adapter instanceof BrowserAdapter)) {
    return;
  }
  analytics.replay = new ReplayRecorder({
    getSessionId: () => adapter.getReplaySessionId(),
    onRotate: (listener) => adapter.onSessionRotated(listener),
  });
}
