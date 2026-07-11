import { record, type eventWithTime } from 'rrweb';

// De-branded from posthog's session-recording.ts rrweb integration.
//
// This is the HEAVY half of the recorder — the only module that imports rrweb, and the
// sole reason a consumer who imports base `@randomtoni/analytics-kit-browser` never bundles rrweb.
// It is the `@randomtoni/analytics-kit-browser/replay` tsup entry (`dist/replay.*`); the base graph
// reaches it ONLY through the shell's dynamic `import('./replay')` in `start()`, so
// esbuild code-splits rrweb out of `dist/index.*`. rrweb types stay confined here — the
// neutral `SessionReplayPort` names none of them.

// The one DOM-recording event the recorder emits; rrweb's own type, adapter-internal. S4
// threads these buffered events onto the replay delivery path.
export type ReplayEvent = eventWithTime;

// The DOM-content masking policy the recorder applies (E14-S4) — the NEW privacy surface,
// orthogonal to the E3/E4 property-key allowlist. Neutral field names that the shell derives
// from `config.sessionReplay.masking`; this module is the ONLY place they map onto rrweb's
// own `record()` option names, keeping rrweb vocabulary confined to the body. Absent ⇒ the
// privacy-safe default (`maskAllInputs: true`).
export interface ReplayMaskingOptions {
  maskAllInputs?: boolean;
  maskTextSelector?: string;
  blockSelector?: string;
}

// Handle returned by starting a recording: a stop function plus the live snapshot buffer
// the started recording appends every emitted event to. S4 drains `buffer` on its flush
// cadence; S2 only holds it (no delivery). Adapter-internal.
export interface ReplayRecordingHandle {
  stop: () => void;
  buffer: ReplayEvent[];
}

// Begin an rrweb recording. Each emitted DOM event is appended to the returned handle's
// buffer (S4 owns the drain/flush). Returns undefined when rrweb fails to initialize (no
// DOM, unsupported environment) — the caller treats that as an inactive start. The neutral
// masking policy is mapped onto rrweb's `record()` options HERE (the rrweb option names
// never leave this module); `maskAllInputs` defaults to `true` (privacy-safe) when the
// consumer supplies no masking config.
export function startRecording(masking?: ReplayMaskingOptions): ReplayRecordingHandle | undefined {
  const buffer: ReplayEvent[] = [];
  const stop = record({
    emit: (event) => {
      buffer.push(event);
    },
    maskAllInputs: masking?.maskAllInputs ?? true,
    maskTextSelector: masking?.maskTextSelector,
    blockSelector: masking?.blockSelector,
  });
  if (stop === undefined) {
    return undefined;
  }
  return { stop, buffer };
}
