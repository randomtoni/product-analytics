import type { AnalyticsProvider, SessionReplayPort } from 'analytics-kit';
import { BrowserAdapter } from './browser-adapter';
import type { ReplayRecordingHandle } from './replay';

export interface ReplayRecorderOptions {
  // The current session-linkage id, single-sourced through the adapter (never minted here —
  // mirrors how the flag adapter takes `getDistinctId`). A PURE read: `getReplayId` may be
  // called arbitrarily by a consumer, so it must not advance session state. S2 supplies a
  // placeholder source; S3 wires the shared `SessionIdManager` read + an `onRotate` re-key.
  getSessionId: () => string | undefined;
}

// The neutral session-replay recorder — the browser impl of `SessionReplayPort`. It is the
// rrweb-free SHELL of the recorder: it holds the started guard, the recording handle, and
// the id source, but reaches the heavy rrweb body ONLY through a dynamic `import('./replay')`
// inside `start()`. That dynamic boundary is what keeps rrweb out of the base `dist/index.*`
// bundle (esbuild code-splits it into `dist/replay.*`) while `attachReplay` stays synchronous
// so `provider.replay` is populated at construction, mirroring `provider.flags`.
export class ReplayRecorder implements SessionReplayPort {
  private readonly getSessionId: () => string | undefined;
  // Whether a recording is running. Set true synchronously on `start()` (before the rrweb
  // body resolves) so a second `start()` is a no-op; cleared on `stop()`. Reset to false if
  // the async rrweb load fails to initialize.
  private started = false;
  // The live rrweb recording handle (stop fn + snapshot buffer), resolved a tick after
  // `start()` once the replay chunk loads. undefined before it resolves and after `stop()`.
  private handle: ReplayRecordingHandle | undefined;

  constructor(options: ReplayRecorderOptions) {
    this.getSessionId = options.getSessionId;
  }

  // Begin recording (idempotent: a second call while active is a no-op, mirroring the
  // reference `isStarted` guard). The guard flips synchronously so `isActive()` reports
  // true immediately; the actual rrweb `record()` starts once the dynamically-imported
  // replay chunk resolves. A `stop()` racing the pending load is honored — the resolved
  // handle is discarded if the guard was cleared meanwhile. rrweb failing to initialize
  // clears the guard so `isActive()` stays honest.
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    void import('./replay').then(({ startRecording }) => {
      if (!this.started) {
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

  // Halt recording: stop the live rrweb recording (if it resolved) and clear the guard.
  // Safe to call before the pending load resolves — clearing the guard makes the resolved
  // handle discard itself.
  stop(): void {
    this.handle?.stop();
    this.handle = undefined;
    this.started = false;
  }

  isActive(): boolean {
    return this.started;
  }

  // The neutral session-linkage id, read straight from the injected source. S3 wires this
  // to the shared session read so the recording stitches to the same id captured events
  // carry; S2 returns the placeholder source's value.
  getReplayId(): string | undefined {
    return this.getSessionId();
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
  });
}
