import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AnalyticsProvider } from 'analytics-kit';
import { NoopAdapter } from 'analytics-kit';
import { ReplayRecorder, attachReplay } from './replay-recorder';
import { BrowserAdapter } from './browser-adapter';
import type { ReplayRecordingHandle } from './replay';

// Mock the heavy rrweb body so the shell's control surface is testable without a real DOM
// recording. `startRecording` is swapped for a stub returning a fake handle (a stop spy +
// empty buffer), or undefined to exercise the rrweb-failed-to-init path.
const replayMock = vi.hoisted(() => ({
  startRecording: vi.fn<() => ReplayRecordingHandle | undefined>(),
}));

vi.mock('./replay', () => ({
  startRecording: () => replayMock.startRecording(),
}));

// The shell's dynamic `import('./replay')` settles across several microtasks (module
// resolution), so tests poll the observable end-state with `vi.waitFor` rather than flush a
// fixed number of ticks. `settleReplayLoad` drains the import queue for cases whose end-state
// is an ABSENCE (nothing started, because a stop raced the load) — it waits until the mock's
// call count stops changing, without requiring a call to have happened.
async function settleReplayLoad(): Promise<void> {
  let previous = -1;
  await vi.waitFor(() => {
    const current = replayMock.startRecording.mock.calls.length;
    if (current !== previous) {
      previous = current;
      throw new Error('replay load still settling');
    }
  });
}

function fakeHandle(): { handle: ReplayRecordingHandle; stop: ReturnType<typeof vi.fn> } {
  const stop = vi.fn();
  return { handle: { stop, buffer: [] }, stop };
}

// A controllable stand-in for the adapter's `onSessionRotated`: primes the listener with the
// current id on subscribe (mirroring the real fan-out), records subscribe/unsubscribe, and
// exposes `rotate(id)` so a test can drive a rotation edge. `current` is the shared session id
// the recorder reads via `getSessionId` — `rotate` advances it before notifying so the two
// stay consistent, exactly as the real adapter commits the id then fires.
function fakeRotationSource(initialId: string | undefined) {
  const state = { current: initialId };
  let listener: ((id: string | undefined) => void) | undefined;
  let subscribed = false;
  return {
    getSessionId: () => state.current,
    onRotate: (fn: (id: string | undefined) => void): (() => void) => {
      listener = fn;
      subscribed = true;
      fn(state.current); // prime on subscribe
      return () => {
        listener = undefined;
        subscribed = false;
      };
    },
    rotate: (id: string | undefined): void => {
      state.current = id;
      listener?.(id);
    },
    isSubscribed: (): boolean => subscribed,
  };
}

afterEach(async () => {
  // Drain any dynamic-import microtasks a still-running recorder left pending BEFORE resetting
  // the mock, so a leaked `beginSegment` resolution lands on the old mock and never bleeds a
  // spurious `startRecording` call into the next test.
  await settleReplayLoad();
  vi.restoreAllMocks();
  replayMock.startRecording.mockReset();
});

describe('ReplayRecorder control surface (E14-S2)', () => {
  test('isActive is false before start', () => {
    const recorder = new ReplayRecorder({ getSessionId: () => undefined });
    expect(recorder.isActive()).toBe(false);
  });

  test('start begins a recording and isActive reports true synchronously', async () => {
    const { handle } = fakeHandle();
    replayMock.startRecording.mockReturnValue(handle);
    const recorder = new ReplayRecorder({ getSessionId: () => 's1' });

    recorder.start();
    // The guard flips synchronously — isActive is true before the rrweb chunk resolves.
    expect(recorder.isActive()).toBe(true);

    await vi.waitFor(() => expect(replayMock.startRecording).toHaveBeenCalledTimes(1));
    expect(recorder.isActive()).toBe(true);
  });

  test('start is idempotent — a second call while active does not start a second recording', async () => {
    const { handle } = fakeHandle();
    replayMock.startRecording.mockReturnValue(handle);
    const recorder = new ReplayRecorder({ getSessionId: () => 's1' });

    recorder.start();
    recorder.start();
    await settleReplayLoad();

    expect(replayMock.startRecording).toHaveBeenCalledTimes(1);
  });

  test('stop halts the recording and isActive returns false', async () => {
    const { handle, stop } = fakeHandle();
    replayMock.startRecording.mockReturnValue(handle);
    const recorder = new ReplayRecorder({ getSessionId: () => 's1' });

    recorder.start();
    await vi.waitFor(() => expect(replayMock.startRecording).toHaveBeenCalledTimes(1));
    recorder.stop();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(recorder.isActive()).toBe(false);
  });

  test('start after stop begins a fresh recording (guard re-armed)', async () => {
    const first = fakeHandle();
    const second = fakeHandle();
    replayMock.startRecording.mockReturnValueOnce(first.handle).mockReturnValueOnce(second.handle);
    const recorder = new ReplayRecorder({ getSessionId: () => 's1' });

    recorder.start();
    await vi.waitFor(() => expect(replayMock.startRecording).toHaveBeenCalledTimes(1));
    recorder.stop();
    recorder.start();
    await vi.waitFor(() => expect(replayMock.startRecording).toHaveBeenCalledTimes(2));

    expect(recorder.isActive()).toBe(true);
  });

  test('a stop racing the pending rrweb load discards the resolved recording', async () => {
    const { handle, stop } = fakeHandle();
    replayMock.startRecording.mockReturnValue(handle);
    const recorder = new ReplayRecorder({ getSessionId: () => 's1' });

    recorder.start();
    // Stop BEFORE the dynamic import resolves — the guard is cleared, so when the load
    // resolves the shell must bail out (never calling startRecording, never left running).
    recorder.stop();
    await settleReplayLoad();

    expect(recorder.isActive()).toBe(false);
    // The load bailed before starting a recording, so no recording exists to leak.
    expect(replayMock.startRecording).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  test('rrweb failing to initialize (undefined handle) clears the guard so isActive is honest', async () => {
    replayMock.startRecording.mockReturnValue(undefined);
    const recorder = new ReplayRecorder({ getSessionId: () => 's1' });

    recorder.start();
    expect(recorder.isActive()).toBe(true); // optimistic until the load resolves
    // rrweb returned no recording — the guard is cleared once the load resolves.
    await vi.waitFor(() => expect(recorder.isActive()).toBe(false));
  });

  test('getReplayId reads the injected session-id source (never mints its own)', () => {
    let current: string | undefined = undefined;
    const recorder = new ReplayRecorder({ getSessionId: () => current });

    expect(recorder.getReplayId()).toBeUndefined();
    current = 'session-abc';
    expect(recorder.getReplayId()).toBe('session-abc');
  });
});

describe('ReplayRecorder re-key on rotation (E14-S3)', () => {
  test('the subscribe-time prime does NOT re-key — the first segment is the only recording', async () => {
    const { handle } = fakeHandle();
    replayMock.startRecording.mockReturnValue(handle);
    const source = fakeRotationSource('s1');
    const recorder = new ReplayRecorder({ getSessionId: source.getSessionId, onRotate: source.onRotate });

    recorder.start();
    await settleReplayLoad();

    // start() begins ONE segment; the prime carries the same id it already keyed, so no re-key.
    expect(replayMock.startRecording).toHaveBeenCalledTimes(1);
    expect(source.isSubscribed()).toBe(true);
  });

  test('re-keys on rotation — stops the current recording and starts a fresh segment', async () => {
    const first = fakeHandle();
    const second = fakeHandle();
    replayMock.startRecording.mockReturnValueOnce(first.handle).mockReturnValueOnce(second.handle);
    const source = fakeRotationSource('s1');
    const recorder = new ReplayRecorder({ getSessionId: source.getSessionId, onRotate: source.onRotate });

    recorder.start();
    await vi.waitFor(() => expect(replayMock.startRecording).toHaveBeenCalledTimes(1));

    source.rotate('s2');
    // The old segment is stopped and a new one begins — one recording never spans two ids.
    expect(first.stop).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(replayMock.startRecording).toHaveBeenCalledTimes(2));
    expect(recorder.isActive()).toBe(true);
  });

  test('getReplayId reflects the NEW id after a rotation re-key', async () => {
    replayMock.startRecording.mockReturnValue(fakeHandle().handle);
    const source = fakeRotationSource('s1');
    const recorder = new ReplayRecorder({ getSessionId: source.getSessionId, onRotate: source.onRotate });

    recorder.start();
    await settleReplayLoad();
    expect(recorder.getReplayId()).toBe('s1');

    source.rotate('s2');
    // The linkage id follows the shared source — the re-keyed segment stitches to the new id.
    expect(recorder.getReplayId()).toBe('s2');
  });

  test('a rotation to the SAME id does not re-key (redundant notification is ignored)', async () => {
    replayMock.startRecording.mockReturnValue(fakeHandle().handle);
    const source = fakeRotationSource('s1');
    const recorder = new ReplayRecorder({ getSessionId: source.getSessionId, onRotate: source.onRotate });

    recorder.start();
    await settleReplayLoad();
    expect(replayMock.startRecording).toHaveBeenCalledTimes(1);

    source.rotate('s1'); // same id — not a real rotation edge
    await settleReplayLoad();

    expect(replayMock.startRecording).toHaveBeenCalledTimes(1);
  });

  test('stop unsubscribes from rotation — a later rotation does not re-key', async () => {
    replayMock.startRecording.mockReturnValue(fakeHandle().handle);
    const source = fakeRotationSource('s1');
    const recorder = new ReplayRecorder({ getSessionId: source.getSessionId, onRotate: source.onRotate });

    recorder.start();
    await vi.waitFor(() => expect(replayMock.startRecording).toHaveBeenCalledTimes(1));
    recorder.stop();
    expect(source.isSubscribed()).toBe(false);

    source.rotate('s2'); // reaches nobody
    await settleReplayLoad();

    expect(replayMock.startRecording).toHaveBeenCalledTimes(1);
    expect(recorder.isActive()).toBe(false);
  });

  test('a rotation while inactive (after stop) is a no-op', async () => {
    replayMock.startRecording.mockReturnValue(fakeHandle().handle);
    const source = fakeRotationSource('s1');
    const recorder = new ReplayRecorder({ getSessionId: source.getSessionId, onRotate: source.onRotate });

    recorder.start();
    await settleReplayLoad();
    recorder.stop();

    // handleRotation is guarded on `started`; calling the (now-detached) listener path is inert.
    source.rotate('s2');
    await settleReplayLoad();
    expect(replayMock.startRecording).toHaveBeenCalledTimes(1);
  });

  test('degrades to a single non-re-keying segment when no onRotate source is supplied', async () => {
    replayMock.startRecording.mockReturnValue(fakeHandle().handle);
    // No onRotate — mirrors an id source with no rotation signal.
    const recorder = new ReplayRecorder({ getSessionId: () => 's1' });

    recorder.start();
    await settleReplayLoad();

    expect(recorder.isActive()).toBe(true);
    expect(replayMock.startRecording).toHaveBeenCalledTimes(1);
  });
});

describe('attachReplay slot population (E14-S2, bar B)', () => {
  test('populates provider.replay with a working SessionReplayPort when the adapter is keyed', () => {
    const analytics = { replay: undefined } as unknown as AnalyticsProvider;
    const adapter = new BrowserAdapter({ key: 'replay-key' });

    attachReplay(analytics, adapter);

    expect(analytics.replay).toBeDefined();
    expect(typeof analytics.replay!.start).toBe('function');
    expect(typeof analytics.replay!.stop).toBe('function');
    expect(typeof analytics.replay!.isActive).toBe('function');
    expect(typeof analytics.replay!.getReplayId).toBe('function');
    expect(analytics.replay!.isActive()).toBe(false);
  });

  test('getReplayId single-sources the id through the adapter (no second id authority)', () => {
    const analytics = { replay: undefined } as unknown as AnalyticsProvider;
    const adapter = new BrowserAdapter({ key: 'replay-id-key' });
    vi.spyOn(adapter, 'getReplaySessionId').mockReturnValue('adapter-session-7');

    attachReplay(analytics, adapter);

    expect(analytics.replay!.getReplayId()).toBe('adapter-session-7');
  });

  test('leaves provider.replay undefined for an unkeyed client (NoopAdapter)', () => {
    const analytics = { replay: undefined } as unknown as AnalyticsProvider;

    attachReplay(analytics, new NoopAdapter());

    expect(analytics.replay).toBeUndefined();
  });
});
