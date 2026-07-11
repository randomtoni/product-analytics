import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AnalyticsProvider } from '@randomtoni/analytics-kit';
import { NoopAdapter } from '@randomtoni/analytics-kit';
import { ReplayRecorder, attachReplay } from './replay-recorder';
import { BrowserAdapter } from './browser-adapter';
import type { ReplayRecordingHandle } from './replay';
import type { ReplayDelivery } from './replay-transport';

// A no-op delivery sink for the control-surface / re-key tests that don't assert delivery
// (S4 delivery is exercised in its own describe block below with a recording spy).
function noopDelivery(): ReplayDelivery {
  return { send: () => {} };
}

// A recording delivery sink: `send` is a spy so the S4 tests can assert WHAT was flushed
// (the events, the session tag, the keepalive/teardown flag) and, crucially, that a
// sampled-out / pending session flushes NOTHING.
function mockDelivery(): { delivery: ReplayDelivery; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  return { delivery: { send }, send };
}

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
    const recorder = new ReplayRecorder({ delivery: noopDelivery(), getSessionId: () => undefined });
    expect(recorder.isActive()).toBe(false);
  });

  test('start begins a recording and isActive reports true synchronously', async () => {
    const { handle } = fakeHandle();
    replayMock.startRecording.mockReturnValue(handle);
    const recorder = new ReplayRecorder({ delivery: noopDelivery(), getSessionId: () => 's1' });

    recorder.start();
    // The guard flips synchronously — isActive is true before the rrweb chunk resolves.
    expect(recorder.isActive()).toBe(true);

    await vi.waitFor(() => expect(replayMock.startRecording).toHaveBeenCalledTimes(1));
    expect(recorder.isActive()).toBe(true);
  });

  test('start is idempotent — a second call while active does not start a second recording', async () => {
    const { handle } = fakeHandle();
    replayMock.startRecording.mockReturnValue(handle);
    const recorder = new ReplayRecorder({ delivery: noopDelivery(), getSessionId: () => 's1' });

    recorder.start();
    recorder.start();
    await settleReplayLoad();

    expect(replayMock.startRecording).toHaveBeenCalledTimes(1);
  });

  test('stop halts the recording and isActive returns false', async () => {
    const { handle, stop } = fakeHandle();
    replayMock.startRecording.mockReturnValue(handle);
    const recorder = new ReplayRecorder({ delivery: noopDelivery(), getSessionId: () => 's1' });

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
    const recorder = new ReplayRecorder({ delivery: noopDelivery(), getSessionId: () => 's1' });

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
    const recorder = new ReplayRecorder({ delivery: noopDelivery(), getSessionId: () => 's1' });

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
    const recorder = new ReplayRecorder({ delivery: noopDelivery(), getSessionId: () => 's1' });

    recorder.start();
    expect(recorder.isActive()).toBe(true); // optimistic until the load resolves
    // rrweb returned no recording — the guard is cleared once the load resolves.
    await vi.waitFor(() => expect(recorder.isActive()).toBe(false));
  });

  test('getReplayId reads the injected session-id source (never mints its own)', () => {
    let current: string | undefined = undefined;
    const recorder = new ReplayRecorder({ delivery: noopDelivery(), getSessionId: () => current });

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
    const recorder = new ReplayRecorder({ delivery: noopDelivery(), getSessionId: source.getSessionId, onRotate: source.onRotate });

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
    const recorder = new ReplayRecorder({ delivery: noopDelivery(), getSessionId: source.getSessionId, onRotate: source.onRotate });

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
    const recorder = new ReplayRecorder({ delivery: noopDelivery(), getSessionId: source.getSessionId, onRotate: source.onRotate });

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
    const recorder = new ReplayRecorder({ delivery: noopDelivery(), getSessionId: source.getSessionId, onRotate: source.onRotate });

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
    const recorder = new ReplayRecorder({ delivery: noopDelivery(), getSessionId: source.getSessionId, onRotate: source.onRotate });

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
    const recorder = new ReplayRecorder({ delivery: noopDelivery(), getSessionId: source.getSessionId, onRotate: source.onRotate });

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
    const recorder = new ReplayRecorder({ delivery: noopDelivery(), getSessionId: () => 's1' });

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

    attachReplay(analytics, adapter, {});

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

    attachReplay(analytics, adapter, {});

    expect(analytics.replay!.getReplayId()).toBe('adapter-session-7');
  });

  test('leaves provider.replay undefined for an unkeyed client (NoopAdapter)', () => {
    const analytics = { replay: undefined } as unknown as AnalyticsProvider;

    attachReplay(analytics, new NoopAdapter(), {});

    expect(analytics.replay).toBeUndefined();
  });

  test('threads sampleRate + masking from config into the recorder (E14-S4)', () => {
    const analytics = { replay: undefined } as unknown as AnalyticsProvider;
    const adapter = new BrowserAdapter({ key: 'replay-cfg-key' });

    // A valid config threads through without throwing and produces a working port; an
    // out-of-range sampleRate does NOT reject at attach (it normalizes downstream).
    attachReplay(analytics, adapter, {
      ingestHost: 'https://analytics.example.com',
      sessionReplay: {
        enabled: true,
        sampleRate: 1.7,
        masking: { maskAllInputs: false, maskTextSelector: '.secret' },
      },
    });

    expect(analytics.replay).toBeDefined();
    expect(analytics.replay!.isActive()).toBe(false);
  });
});

// The event a rotation notification/prime carries and the id `getSessionId` reports must stay
// consistent — the recorder tags a flush with `getSessionId()`, so the fake must advance the id
// so the tag matches the segment. This mirrors fakeRotationSource but exposes the live handle
// pushing so a test can simulate rrweb emitting into the buffer, then trigger a flush.
async function startWithHandle(
  recorder: ReplayRecorder
): Promise<ReplayRecordingHandle> {
  const { handle } = fakeHandle();
  replayMock.startRecording.mockReturnValue(handle);
  recorder.start();
  await vi.waitFor(() => expect(replayMock.startRecording).toHaveBeenCalledTimes(1));
  return handle;
}

describe('ReplayRecorder delivery path (E14-S4)', () => {
  test('a flush drains the buffer and delivers the events tagged with getReplayId', async () => {
    const { delivery, send } = mockDelivery();
    const recorder = new ReplayRecorder({ delivery, getSessionId: () => 'sess-1' });
    const handle = await startWithHandle(recorder);

    // Simulate rrweb emitting two DOM events into the live buffer.
    handle.buffer.push({ timestamp: 1 } as never, { timestamp: 2 } as never);

    // A stop() triggers a teardown flush of the final segment.
    recorder.stop();

    expect(send).toHaveBeenCalledTimes(1);
    const [events, sessionId, keepalive] = send.mock.calls[0];
    expect(events).toHaveLength(2);
    expect(sessionId).toBe('sess-1'); // tagged with the shared getReplayId session
    expect(keepalive).toBe(true); // stop is a teardown flush
    // The buffer was drained — a subsequent flush ships nothing.
    expect(handle.buffer).toHaveLength(0);
  });

  test('an empty buffer flushes nothing (no spurious delivery)', async () => {
    const { delivery, send } = mockDelivery();
    const recorder = new ReplayRecorder({ delivery, getSessionId: () => 'sess-empty' });
    await startWithHandle(recorder);

    recorder.stop();

    expect(send).not.toHaveBeenCalled();
  });
});

describe('ReplayRecorder teardown flush triggers (E14-S4)', () => {
  test('a pagehide dispatch flushes the final segment (keepalive)', async () => {
    const { delivery, send } = mockDelivery();
    const recorder = new ReplayRecorder({ delivery, getSessionId: () => 'sess-ph' });
    const handle = await startWithHandle(recorder);
    handle.buffer.push({ timestamp: 1 } as never);

    window.dispatchEvent(new Event('pagehide'));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][2]).toBe(true); // teardown flush
    recorder.stop();
  });

  test('a visibilitychange to hidden flushes the final segment', async () => {
    const { delivery, send } = mockDelivery();
    const recorder = new ReplayRecorder({ delivery, getSessionId: () => 'sess-vis' });
    const handle = await startWithHandle(recorder);
    handle.buffer.push({ timestamp: 1 } as never);

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][2]).toBe(true);
    recorder.stop();
  });

  test('stop() flushes the final segment then unbinds the lifecycle listeners', async () => {
    const { delivery, send } = mockDelivery();
    const recorder = new ReplayRecorder({ delivery, getSessionId: () => 'sess-stop' });
    const handle = await startWithHandle(recorder);
    handle.buffer.push({ timestamp: 1 } as never);

    recorder.stop();
    expect(send).toHaveBeenCalledTimes(1);

    // After stop, a lifecycle event reaches nobody — no second flush.
    window.dispatchEvent(new Event('pagehide'));
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('a session rotation flushes the outgoing segment before re-keying (bounds the segment)', async () => {
    const { delivery, send } = mockDelivery();
    const first = fakeHandle();
    const second = fakeHandle();
    replayMock.startRecording.mockReturnValueOnce(first.handle).mockReturnValueOnce(second.handle);
    const source = fakeRotationSource('s1');
    const recorder = new ReplayRecorder({
      delivery,
      getSessionId: source.getSessionId,
      onRotate: source.onRotate,
    });

    recorder.start();
    await vi.waitFor(() => expect(replayMock.startRecording).toHaveBeenCalledTimes(1));
    first.handle.buffer.push({ timestamp: 1 } as never);

    source.rotate('s2');

    // The outgoing segment is flushed and tagged with the LIVE `getSessionId()` at flush time —
    // which the rotate-notify has already advanced to s2 (mirroring the adapter's commit-then-fire
    // order: the id source advances before the recorder's rotation handler runs). The flush bounds
    // the segment on the live id, not the id the buffered snapshots were recorded under.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toBe('s2'); // getReplayId reads the already-advanced source
    recorder.stop();
  });
});

describe('ReplayRecorder sampling flush-guard (E14-S4)', () => {
  test('a sampled-OUT session records NOTHING and delivers NOTHING (never starts rrweb)', async () => {
    const { delivery, send } = mockDelivery();
    replayMock.startRecording.mockReturnValue(fakeHandle().handle);
    // sampleRate 0 → every session is sampled out.
    const recorder = new ReplayRecorder({ delivery, getSessionId: () => 'sess-out', sampleRate: 0 });

    recorder.start();
    // The sampled-out verdict short-circuits beginSegment: no rrweb recording is ever started,
    // so there is no handle and no buffer to accumulate into.
    await settleReplayLoad();
    expect(replayMock.startRecording).not.toHaveBeenCalled();

    // Neither a teardown nor stop flushes a sampled-out session (there is nothing to flush).
    window.dispatchEvent(new Event('pagehide'));
    recorder.stop();

    expect(send).not.toHaveBeenCalled();
  });

  test('a sampled-IN session (rate 1) delivers normally', async () => {
    const { delivery, send } = mockDelivery();
    const recorder = new ReplayRecorder({ delivery, getSessionId: () => 'sess-in', sampleRate: 1 });
    const handle = await startWithHandle(recorder);
    handle.buffer.push({ timestamp: 1 } as never);

    recorder.stop();

    expect(send).toHaveBeenCalledTimes(1);
  });

  test('a PENDING decision (no session id yet) records NOTHING and does not flush', async () => {
    const { delivery, send } = mockDelivery();
    replayMock.startRecording.mockReturnValue(fakeHandle().handle);
    // getSessionId returns undefined at start → the sampling decision is pending.
    const recorder = new ReplayRecorder({
      delivery,
      getSessionId: () => undefined,
      sampleRate: 0.5,
    });

    recorder.start();
    // A pending verdict short-circuits beginSegment: no rrweb recording is started, so no batch
    // can leak for a session the recorder has not yet decided to keep.
    await settleReplayLoad();
    expect(replayMock.startRecording).not.toHaveBeenCalled();

    recorder.stop();

    expect(send).not.toHaveBeenCalled();
  });

  test('sampling is re-decided on rotation — a sampled-out session records nothing across a rotation', async () => {
    const { delivery, send } = mockDelivery();
    replayMock.startRecording.mockReturnValue(fakeHandle().handle);
    // Rate 0 sampled the first session out; the re-decision on rotation is also rate 0, so it
    // stays out — assert the guard holds ACROSS a rotation (neither segment ever records).
    const source = fakeRotationSource('s1');
    const recorder = new ReplayRecorder({
      delivery,
      getSessionId: source.getSessionId,
      onRotate: source.onRotate,
      sampleRate: 0,
    });

    recorder.start();
    await settleReplayLoad();

    source.rotate('s2'); // re-decides sampling for s2 (still out at rate 0)
    await settleReplayLoad();
    recorder.stop();

    // Neither segment recorded — the re-decided sampling verdict gated both, so no rrweb
    // recording ever started and nothing could leak.
    expect(replayMock.startRecording).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  // U1 regression: a sampled-out session driven across many poll ticks must not accumulate a
  // buffer or do any per-tick work — it never records, so each tick drains nothing. Under the
  // OLD behavior (beginSegment ran unconditionally + the poll JSON.stringify'd the buffer via
  // the size-check) this session recorded forever into an unbounded buffer that never drained.
  test('a sampled-out session across many poll ticks never records, accumulates, or serializes (U1)', async () => {
    vi.useFakeTimers();
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      const { delivery, send } = mockDelivery();
      replayMock.startRecording.mockReturnValue(fakeHandle().handle);
      const recorder = new ReplayRecorder({ delivery, getSessionId: () => 'sess-out', sampleRate: 0 });

      recorder.start();
      await vi.runOnlyPendingTimersAsync(); // settle the (bailed) dynamic import

      // No rrweb recording ever started, so there is no handle/buffer to accumulate into.
      expect(replayMock.startRecording).not.toHaveBeenCalled();
      expect(stringify).not.toHaveBeenCalled();

      // Drive well past the size-trigger the old code would have hit, over several poll ticks.
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(2000); // one FLUSH_POLL_INTERVAL_MS tick
      }

      // Across all ticks: nothing recorded, nothing serialized, nothing delivered.
      expect(replayMock.startRecording).not.toHaveBeenCalled();
      expect(stringify).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();

      recorder.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ReplayRecorder sampleRate normalization (E14-S4)', () => {
  test('an out-of-range sampleRate degrades to record-all (never rejects at construction)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { delivery, send } = mockDelivery();
    // 1.7 is out of [0,1]; normalize-to-default records ALL (does not silently clamp to 100%
    // as a "valid" setting, and does not throw) — a warn surfaces the misconfig.
    const recorder = new ReplayRecorder({ delivery, getSessionId: () => 'sess-oor', sampleRate: 1.7 });
    const handle = await startWithHandle(recorder);
    handle.buffer.push({ timestamp: 1 } as never);

    recorder.stop();

    expect(warn).toHaveBeenCalled();
    // Record-all ⇒ the session is kept ⇒ delivery happens.
    expect(send).toHaveBeenCalledTimes(1);
  });
});
