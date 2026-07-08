import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_MAX_RETRIES,
  STATUS_ZERO_MAX_RETRIES,
  RetryQueue,
  type RetryQueueOptions,
  isRetryableStatus,
  maxRetriesForStatus,
  pickNextRetryDelay,
} from './retry-queue';

afterEach(() => {
  vi.useRealTimers();
});

const BASE = 3000;
const CAP = 30 * 60 * 1000;

describe('pickNextRetryDelay — exponential backoff base*2**n', () => {
  test('with zero jitter (random=0.5) the delay is exactly base*2**n', () => {
    const half = () => 0.5;
    expect(pickNextRetryDelay(0, half)).toBe(BASE); // 3000 * 2**0
    expect(pickNextRetryDelay(1, half)).toBe(BASE * 2); // 6000
    expect(pickNextRetryDelay(2, half)).toBe(BASE * 4); // 12000
    expect(pickNextRetryDelay(3, half)).toBe(BASE * 8); // 24000
  });

  test('is capped at 30 minutes regardless of how many retries have elapsed', () => {
    const half = () => 0.5;
    // 3000 * 2**10 = 3,072,000 > 30min (1,800,000) — the cap holds.
    expect(pickNextRetryDelay(10, half)).toBe(CAP);
    expect(pickNextRetryDelay(50, half)).toBe(CAP);
  });

  test('applies -50% jitter at the low bound (random=0) → half the capped value', () => {
    // capped=3000, min=1500; jitterFraction=-0.5; jitter=-0.5*(3000-1500)=-750.
    // ceil(3000 - 750) = 2250.
    expect(pickNextRetryDelay(0, () => 0)).toBe(2250);
  });

  test('applies +50% jitter at the high bound (random=1) → capped + half-of-half', () => {
    // jitterFraction=0.5; jitter=0.5*(3000-1500)=750. ceil(3000+750)=3750.
    expect(pickNextRetryDelay(0, () => 1)).toBe(3750);
  });

  test('jitter stays within +/-50% of the delta around the capped value', () => {
    for (let n = 0; n < 6; n += 1) {
      const capped = Math.min(CAP, BASE * 2 ** n);
      const low = pickNextRetryDelay(n, () => 0);
      const high = pickNextRetryDelay(n, () => 1);
      const mid = pickNextRetryDelay(n, () => 0.5);
      expect(mid).toBe(capped);
      expect(low).toBe(Math.ceil(capped - (capped - capped / 2) / 2));
      expect(high).toBe(Math.ceil(capped + (capped - capped / 2) / 2));
      expect(low).toBeLessThan(mid);
      expect(high).toBeGreaterThan(mid);
    }
  });

  test('defaults to Math.random when no jitter fn is supplied', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(pickNextRetryDelay(0)).toBe(BASE);
    spy.mockRestore();
  });
});

describe('isRetryableStatus — network/5xx only, never 4xx', () => {
  test('a 200 is a success — not retryable', () => {
    expect(isRetryableStatus(200)).toBe(false);
  });

  test('a status-0 (network / no HTTP response) is retryable', () => {
    expect(isRetryableStatus(0)).toBe(true);
  });

  test('every 5xx is retryable', () => {
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(502)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(599)).toBe(true);
  });

  test('NO 4xx is ever retryable — a permanent rejection', () => {
    for (const status of [400, 401, 403, 404, 413, 429, 499]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });

  test('other 2xx/3xx are not retryable (only a bare 200 counts as success in the split)', () => {
    // Mirrors the ported split: status !== 200 && (status < 400 || status >= 500).
    // A 201/204 or a 3xx falls in the < 400 branch and IS retryable per the port.
    expect(isRetryableStatus(204)).toBe(true);
    expect(isRetryableStatus(301)).toBe(true);
  });
});

describe('maxRetriesForStatus — budgets', () => {
  test('status-0 gets the short budget of 3', () => {
    expect(maxRetriesForStatus(0)).toBe(STATUS_ZERO_MAX_RETRIES);
    expect(STATUS_ZERO_MAX_RETRIES).toBe(3);
  });

  test('a 5xx gets the full budget of 10', () => {
    expect(maxRetriesForStatus(500)).toBe(DEFAULT_MAX_RETRIES);
    expect(maxRetriesForStatus(503)).toBe(DEFAULT_MAX_RETRIES);
    expect(DEFAULT_MAX_RETRIES).toBe(10);
  });
});

function makeQueue(
  overrides: Partial<RetryQueueOptions<string>> = {}
): {
  queue: RetryQueue<string>;
  sends: Array<{ batch: string[]; attempt: number }>;
} {
  const sends: Array<{ batch: string[]; attempt: number }> = [];
  const queue = new RetryQueue<string>({
    send: async (batch, attempt) => {
      sends.push({ batch, attempt });
    },
    random: () => 0.5, // deterministic zero-jitter backoff
    isOnline: () => true,
    ...overrides,
  });
  return { queue, sends };
}

describe('RetryQueue — scheduling + poller', () => {
  test('a scheduled batch re-sends after its backoff delay elapses (fake timers)', () => {
    vi.useFakeTimers();
    const { queue, sends } = makeQueue();

    queue.scheduleRetry(['a'], 0); // first retry: delay = 3000 (zero jitter)
    expect(sends).toHaveLength(0);
    expect(queue.length).toBe(1);

    // The poller ticks at 3000ms; retryAt = now + 3000 has passed by then.
    vi.advanceTimersByTime(3000);

    expect(sends).toHaveLength(1);
    // The re-send carries the advanced attempt count (1 retry already performed).
    expect(sends[0]).toEqual({ batch: ['a'], attempt: 1 });
    expect(queue.length).toBe(0);
  });

  test('holds a batch whose backoff has not yet elapsed', () => {
    vi.useFakeTimers();
    const { queue, sends } = makeQueue();

    queue.scheduleRetry(['a'], 1); // delay = 6000 (base*2**1, zero jitter)

    // One poll tick at 3000ms — retryAt (now+6000) has NOT passed.
    vi.advanceTimersByTime(3000);
    expect(sends).toHaveLength(0);
    expect(queue.length).toBe(1);

    // The next tick reaches 6000ms — now due.
    vi.advanceTimersByTime(3000);
    expect(sends).toHaveLength(1);
  });

  test('stops polling once the queue empties (no runaway timer)', () => {
    vi.useFakeTimers();
    const { queue, sends } = makeQueue();
    queue.scheduleRetry(['a'], 0);
    vi.advanceTimersByTime(3000);
    expect(sends).toHaveLength(1);
    expect(queue.length).toBe(0);

    // With the queue empty the poller must have stopped — no pending timers linger.
    expect(vi.getTimerCount()).toBe(0);
  });

  test('a re-scheduled batch restarts polling after the queue had drained', () => {
    vi.useFakeTimers();
    const { queue, sends } = makeQueue();
    queue.scheduleRetry(['a'], 0);
    vi.advanceTimersByTime(3000);
    expect(sends).toHaveLength(1);

    queue.scheduleRetry(['b'], 0);
    vi.advanceTimersByTime(3000);
    expect(sends).toHaveLength(2);
    expect(sends[1].batch).toEqual(['b']);
  });
});

describe('RetryQueue — online/offline gating', () => {
  test('holds retries while offline and drains them on reconnect', () => {
    vi.useFakeTimers();
    let online = false;
    const { queue, sends } = makeQueue({ isOnline: () => online });

    queue.scheduleRetry(['a'], 0);
    // Even past the backoff, an offline queue re-sends nothing.
    vi.advanceTimersByTime(30_000);
    expect(sends).toHaveLength(0);
    expect(queue.length).toBe(1);

    // Reconnect: the online event flips the gate and drains what is due immediately.
    online = true;
    window.dispatchEvent(new Event('online'));
    expect(sends).toHaveLength(1);
    expect(sends[0].batch).toEqual(['a']);
  });

  test('an offline event pauses re-sends mid-flight', () => {
    vi.useFakeTimers();
    let online = true;
    const { queue, sends } = makeQueue({ isOnline: () => online });

    queue.scheduleRetry(['a'], 0);

    // Go offline before the backoff elapses.
    online = false;
    window.dispatchEvent(new Event('offline'));

    vi.advanceTimersByTime(30_000);
    expect(sends).toHaveLength(0);
    expect(queue.length).toBe(1);
  });

  test('constructs online-by-default in a context with no navigator.onLine', () => {
    // isOnline default treats an absent navigator as online — no throw at construct.
    const { queue } = makeQueue({ isOnline: undefined });
    expect(queue.length).toBe(0);
  });
});

describe('RetryQueue — drain / snapshot entry points (S6 + S9 seam)', () => {
  test('snapshot returns the held batches without clearing the queue (S9 mirror)', () => {
    vi.useFakeTimers();
    const { queue } = makeQueue();
    queue.scheduleRetry(['a'], 0);
    queue.scheduleRetry(['b', 'c'], 0);

    const snap = queue.snapshot();
    expect(snap).toEqual([['a'], ['b', 'c']]);
    // Non-destructive: the queue is untouched.
    expect(queue.length).toBe(2);
  });

  test('snapshot hands back a fresh outer array — mutating it does not touch the queue', () => {
    const { queue } = makeQueue();
    queue.scheduleRetry(['a'], 0);

    const snap = queue.snapshot() as string[][];
    snap.push(['injected']);

    expect(queue.length).toBe(1);
    expect(queue.snapshot()).toEqual([['a']]);
  });

  test('drain returns ALL held batches and empties the queue (S6 unload)', () => {
    vi.useFakeTimers();
    const { queue, sends } = makeQueue();
    queue.scheduleRetry(['a'], 0);
    queue.scheduleRetry(['b'], 0);

    const drained = queue.drain();

    expect(drained).toEqual([['a'], ['b']]);
    expect(queue.length).toBe(0);
    // drain does NOT itself re-send — the beacon transport is S6's concern.
    expect(sends).toHaveLength(0);
  });

  test('drain stops the poller — no re-send fires after a drain', () => {
    vi.useFakeTimers();
    const { queue, sends } = makeQueue();
    queue.scheduleRetry(['a'], 0);

    queue.drain();
    vi.advanceTimersByTime(30_000);

    expect(sends).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('drain unbinds the online/offline listeners — a later online event drains nothing', () => {
    vi.useFakeTimers();
    let online = false;
    const { queue, sends } = makeQueue({ isOnline: () => online });
    queue.scheduleRetry(['a'], 0);

    queue.drain();

    // After drain the listener is gone — a reconnect must not resurrect a re-send.
    online = true;
    window.dispatchEvent(new Event('online'));
    expect(sends).toHaveLength(0);
  });
});
