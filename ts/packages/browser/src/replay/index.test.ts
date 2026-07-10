import { afterEach, describe, expect, test, vi } from 'vitest';
import type { eventWithTime } from 'rrweb';
import { startRecording } from './index';

// Mock rrweb's `record()` so the body's control wiring is testable without a real DOM
// recording. The stub captures the passed `emit` (so a test can drive events into the
// buffer) and returns a configurable stop fn / undefined (the rrweb-failed-to-init path).
const rrwebMock = vi.hoisted(() => ({
  record: vi.fn<(opts: { emit?: (e: unknown, isCheckout?: boolean) => void }) => (() => void) | undefined>(),
  lastEmit: undefined as ((e: unknown, isCheckout?: boolean) => void) | undefined,
}));

vi.mock('rrweb', () => ({
  record: (opts: { emit?: (e: unknown, isCheckout?: boolean) => void }) => {
    rrwebMock.lastEmit = opts.emit;
    return rrwebMock.record(opts);
  },
}));

function fakeEvent(tag: number): eventWithTime {
  return { type: 3, data: {}, timestamp: tag } as unknown as eventWithTime;
}

afterEach(() => {
  rrwebMock.record.mockReset();
  rrwebMock.lastEmit = undefined;
});

describe('startRecording rrweb body (E14-S2)', () => {
  test('starts rrweb and returns a handle with the stop fn and an empty buffer', () => {
    const stop = vi.fn();
    rrwebMock.record.mockReturnValue(stop);

    const handle = startRecording();

    expect(handle).toBeDefined();
    expect(handle!.stop).toBe(stop);
    expect(handle!.buffer).toEqual([]);
  });

  test('emitted rrweb events accumulate into the handle buffer (S4 drains it)', () => {
    rrwebMock.record.mockReturnValue(vi.fn());

    const handle = startRecording();
    expect(handle!.buffer).toHaveLength(0);

    // Drive two events through the emit callback rrweb was handed.
    rrwebMock.lastEmit!(fakeEvent(1));
    rrwebMock.lastEmit!(fakeEvent(2));

    expect(handle!.buffer).toHaveLength(2);
    expect((handle!.buffer[0] as eventWithTime).timestamp).toBe(1);
    expect((handle!.buffer[1] as eventWithTime).timestamp).toBe(2);
  });

  test('returns undefined when rrweb fails to initialize (record returns undefined)', () => {
    rrwebMock.record.mockReturnValue(undefined);

    expect(startRecording()).toBeUndefined();
  });
});
