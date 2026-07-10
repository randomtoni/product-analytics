import { afterEach, describe, expect, test, vi } from 'vitest';
import type { eventWithTime } from 'rrweb';
import { startRecording } from './index';

// Mock rrweb's `record()` so the body's control wiring is testable without a real DOM
// recording. The stub captures the passed `emit` (so a test can drive events into the
// buffer) and the full options object (so the masking tests can assert the record() options),
// and returns a configurable stop fn / undefined (the rrweb-failed-to-init path).
type RecordOptions = {
  emit?: (e: unknown, isCheckout?: boolean) => void;
  maskAllInputs?: boolean;
  maskTextSelector?: string;
  blockSelector?: string;
};
const rrwebMock = vi.hoisted(() => ({
  record: vi.fn<(opts: RecordOptions) => (() => void) | undefined>(),
  lastEmit: undefined as ((e: unknown, isCheckout?: boolean) => void) | undefined,
}));

vi.mock('rrweb', () => ({
  record: (opts: RecordOptions) => {
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

describe('startRecording masking → rrweb record() options (E14-S4)', () => {
  test('defaults to maskAllInputs:true (privacy-safe) when no masking config is supplied', () => {
    rrwebMock.record.mockReturnValue(vi.fn());

    startRecording();

    const opts = rrwebMock.record.mock.calls[0]![0] as {
      maskAllInputs?: boolean;
      maskTextSelector?: string;
      blockSelector?: string;
    };
    expect(opts.maskAllInputs).toBe(true);
    expect(opts.maskTextSelector).toBeUndefined();
    expect(opts.blockSelector).toBeUndefined();
  });

  test('threads the neutral masking fields onto rrweb record() options', () => {
    rrwebMock.record.mockReturnValue(vi.fn());

    startRecording({ maskAllInputs: false, maskTextSelector: '.secret', blockSelector: '.pii' });

    const opts = rrwebMock.record.mock.calls[0]![0] as {
      maskAllInputs?: boolean;
      maskTextSelector?: string;
      blockSelector?: string;
    };
    // A consumer opt-out of maskAllInputs is honored; the selectors reach rrweb verbatim.
    expect(opts.maskAllInputs).toBe(false);
    expect(opts.maskTextSelector).toBe('.secret');
    expect(opts.blockSelector).toBe('.pii');
  });

  test('a partial masking config keeps the maskAllInputs default true', () => {
    rrwebMock.record.mockReturnValue(vi.fn());

    startRecording({ maskTextSelector: '.only-text' });

    const opts = rrwebMock.record.mock.calls[0]![0] as { maskAllInputs?: boolean };
    // Absent maskAllInputs in a supplied masking object still defaults to the privacy-safe true.
    expect(opts.maskAllInputs).toBe(true);
  });
});
