import { record, type eventWithTime } from 'rrweb';

// De-branded from posthog's session-recording.ts rrweb integration.
//
// This is the HEAVY half of the recorder — the only module that imports rrweb, and the
// sole reason a consumer who imports base `@analytics-kit/browser` never bundles rrweb.
// It is the `@analytics-kit/browser/replay` tsup entry (`dist/replay.*`); the base graph
// reaches it ONLY through the shell's dynamic `import('./replay')` in `start()`, so
// esbuild code-splits rrweb out of `dist/index.*`. rrweb types stay confined here — the
// neutral `SessionReplayPort` names none of them.

// The one DOM-recording event the recorder emits; rrweb's own type, adapter-internal. S4
// threads these buffered events onto the replay delivery path.
export type ReplayEvent = eventWithTime;

// Handle returned by starting a recording: a stop function plus the live snapshot buffer
// the started recording appends every emitted event to. S4 drains `buffer` on its flush
// cadence; S2 only holds it (no delivery). Adapter-internal.
export interface ReplayRecordingHandle {
  stop: () => void;
  buffer: ReplayEvent[];
}

// Begin an rrweb recording. Each emitted DOM event is appended to the returned handle's
// buffer (S4 owns the drain/flush; S2 only accumulates). Returns undefined when rrweb
// fails to initialize (no DOM, unsupported environment) — the caller treats that as an
// inactive start. Masking options (`maskAllInputs`/`maskTextSelector`/`blockSelector`)
// are threaded here in S4; S2 records with rrweb's defaults, applying no masking config.
export function startRecording(): ReplayRecordingHandle | undefined {
  const buffer: ReplayEvent[] = [];
  const stop = record({
    emit: (event) => {
      buffer.push(event);
    },
  });
  if (stop === undefined) {
    return undefined;
  }
  return { stop, buffer };
}
