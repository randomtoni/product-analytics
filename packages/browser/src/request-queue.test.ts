import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_FLUSH_AT,
  DEFAULT_FLUSH_INTERVAL_MS,
  RequestQueue,
  type RequestQueueOptions,
} from './request-queue';

afterEach(() => {
  vi.useRealTimers();
});

function makeQueue(overrides: Partial<RequestQueueOptions<string>> = {}): {
  queue: RequestQueue<string>;
  batches: string[][];
} {
  const batches: string[][] = [];
  const queue = new RequestQueue<string>({
    send: async (batch) => {
      batches.push(batch);
    },
    ...overrides,
  });
  return { queue, batches };
}

describe('RequestQueue — paused at start', () => {
  test('does NOT flush while paused, even past the interval', () => {
    vi.useFakeTimers();
    const { queue, batches } = makeQueue();

    queue.enqueue('a');
    vi.advanceTimersByTime(DEFAULT_FLUSH_INTERVAL_MS * 2);

    expect(batches).toHaveLength(0);
  });

  test('enable() arms the interval and a subsequent enqueue flushes on elapse', () => {
    vi.useFakeTimers();
    const { queue, batches } = makeQueue();

    queue.enable();
    queue.enqueue('a');
    vi.advanceTimersByTime(DEFAULT_FLUSH_INTERVAL_MS);

    expect(batches).toEqual([['a']]);
  });
});

describe('RequestQueue — interval (time) trigger', () => {
  test('flushes the buffered events after the interval elapses', () => {
    vi.useFakeTimers();
    const { queue, batches } = makeQueue();
    queue.enable();

    queue.enqueue('a');
    queue.enqueue('b');
    // Not yet — one ms short of the interval.
    vi.advanceTimersByTime(DEFAULT_FLUSH_INTERVAL_MS - 1);
    expect(batches).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(batches).toEqual([['a', 'b']]);
  });

  test('honors a custom flushInterval', () => {
    vi.useFakeTimers();
    const { queue, batches } = makeQueue({ flushInterval: 1000 });
    queue.enable();

    queue.enqueue('a');
    vi.advanceTimersByTime(999);
    expect(batches).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(batches).toEqual([['a']]);
  });

  test('clamps a below-floor interval up to 250ms', () => {
    vi.useFakeTimers();
    const { queue, batches } = makeQueue({ flushInterval: 10 });
    queue.enable();

    queue.enqueue('a');
    vi.advanceTimersByTime(249);
    expect(batches).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(batches).toEqual([['a']]);
  });

  test('clamps an above-ceiling interval down to 5000ms', () => {
    vi.useFakeTimers();
    const { queue, batches } = makeQueue({ flushInterval: 60_000 });
    queue.enable();

    queue.enqueue('a');
    vi.advanceTimersByTime(5000);
    expect(batches).toEqual([['a']]);
  });

  test('re-arms the interval for events enqueued after a flush', () => {
    vi.useFakeTimers();
    const { queue, batches } = makeQueue();
    queue.enable();

    queue.enqueue('a');
    vi.advanceTimersByTime(DEFAULT_FLUSH_INTERVAL_MS);
    queue.enqueue('b');
    vi.advanceTimersByTime(DEFAULT_FLUSH_INTERVAL_MS);

    expect(batches).toEqual([['a'], ['b']]);
  });
});

describe('RequestQueue — size (flushAt) trigger', () => {
  test('flushes immediately when flushAt events are buffered, before the interval', () => {
    vi.useFakeTimers();
    const { queue, batches } = makeQueue({ flushAt: 3 });
    queue.enable();

    queue.enqueue('a');
    queue.enqueue('b');
    expect(batches).toHaveLength(0);
    // The third event hits the threshold — flush fires synchronously, no timer wait.
    queue.enqueue('c');
    expect(batches).toEqual([['a', 'b', 'c']]);
  });

  test('the size trigger clears the armed interval so no redundant near-empty flush follows', () => {
    vi.useFakeTimers();
    const { queue, batches } = makeQueue({ flushAt: 2 });
    queue.enable();

    queue.enqueue('a'); // arms the interval
    queue.enqueue('b'); // size trigger fires + clears the timer
    expect(batches).toEqual([['a', 'b']]);

    // The previously-armed interval must NOT fire a second empty batch.
    vi.advanceTimersByTime(DEFAULT_FLUSH_INTERVAL_MS);
    expect(batches).toEqual([['a', 'b']]);
  });

  test('flushes on the EARLIER of interval or size — interval wins when the batch stays small', () => {
    vi.useFakeTimers();
    const { queue, batches } = makeQueue({ flushAt: 100 });
    queue.enable();

    queue.enqueue('a');
    vi.advanceTimersByTime(DEFAULT_FLUSH_INTERVAL_MS);

    expect(batches).toEqual([['a']]);
  });

  test('a floor of 1 guards a misconfigured flushAt of 0 from wedging the queue', () => {
    vi.useFakeTimers();
    const { queue, batches } = makeQueue({ flushAt: 0 });
    queue.enable();

    queue.enqueue('a');

    expect(batches).toEqual([['a']]);
  });
});

describe('RequestQueue — defaults', () => {
  test('exposes the reference interval and size defaults', () => {
    expect(DEFAULT_FLUSH_INTERVAL_MS).toBe(3000);
    expect(DEFAULT_FLUSH_AT).toBe(20);
  });

  test('an undefined interval falls back to the 3000ms default', () => {
    vi.useFakeTimers();
    const { queue, batches } = makeQueue({ flushInterval: undefined });
    queue.enable();

    queue.enqueue('a');
    vi.advanceTimersByTime(2999);
    expect(batches).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(batches).toEqual([['a']]);
  });

  test('the default size trigger fires at 20 buffered events', () => {
    vi.useFakeTimers();
    const { queue, batches } = makeQueue();
    queue.enable();

    for (let i = 0; i < DEFAULT_FLUSH_AT - 1; i += 1) {
      queue.enqueue(`e${i}`);
    }
    expect(batches).toHaveLength(0);
    queue.enqueue('e19');
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(DEFAULT_FLUSH_AT);
  });
});

describe('RequestQueue — flushNow (explicit drain)', () => {
  test('force-drains immediately and resolves after the send settles', async () => {
    const { queue, batches } = makeQueue();
    queue.enable();
    queue.enqueue('a');

    await queue.flushNow();

    expect(batches).toEqual([['a']]);
  });

  test('resolves quietly on an empty buffer (nothing sent)', async () => {
    const { queue, batches } = makeQueue();
    queue.enable();

    await queue.flushNow();

    expect(batches).toHaveLength(0);
  });

  test('awaits an auto-flush POST already in flight (coalesces)', async () => {
    let resolveSend: () => void = () => {};
    const settled: string[] = [];
    const queue = new RequestQueue<string>({
      flushAt: 1,
      send: async (batch) => {
        await new Promise<void>((resolve) => {
          resolveSend = resolve;
        });
        settled.push(batch[0]);
      },
    });
    queue.enable();

    // The size trigger fires an auto-flush that is now hanging on resolveSend.
    queue.enqueue('a');
    expect(settled).toHaveLength(0);

    const flushed = queue.flushNow();
    // flushNow must not resolve while the in-flight send is unsettled.
    resolveSend();
    await flushed;

    expect(settled).toEqual(['a']);
  });
});

describe('RequestQueue — drop (opt-out)', () => {
  test('drops the unsent buffer WITHOUT sending', () => {
    vi.useFakeTimers();
    const { queue, batches } = makeQueue();
    queue.enable();
    queue.enqueue('a');
    queue.enqueue('b');

    queue.drop();
    // A pending interval must not resurrect the dropped events.
    vi.advanceTimersByTime(DEFAULT_FLUSH_INTERVAL_MS);

    expect(batches).toHaveLength(0);
  });

  test('a flushNow after a drop sends nothing', async () => {
    const { queue, batches } = makeQueue();
    queue.enable();
    queue.enqueue('a');

    queue.drop();
    await queue.flushNow();

    expect(batches).toHaveLength(0);
  });

  test('an interval auto-flush rejection does not escape the timer', () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const queue = new RequestQueue<string>({
      send: async (batch) => {
        batches.push(batch);
        throw new Error('network down');
      },
    });
    queue.enable();
    queue.enqueue('a');

    // The timer callback swallows the send rejection (S3 owns retry); advancing
    // the fake clock must not throw an unhandled error.
    expect(() => vi.advanceTimersByTime(DEFAULT_FLUSH_INTERVAL_MS)).not.toThrow();
    expect(batches).toEqual([['a']]);
  });
});

describe('RequestQueue — drain (take-all, no send) [S6]', () => {
  test('returns the buffered events, clears the buffer, and does NOT send', () => {
    const { queue, batches } = makeQueue();
    queue.enable();
    queue.enqueue('a');
    queue.enqueue('b');

    const drained = queue.drain();

    expect(drained).toEqual(['a', 'b']);
    // Take-all did NOT invoke `send` — the beacon transport is the adapter's concern.
    expect(batches).toHaveLength(0);
  });

  test('clears the interval so a pending timer cannot re-flush drained events', () => {
    vi.useFakeTimers();
    const { queue, batches } = makeQueue();
    queue.enable();
    queue.enqueue('a');

    queue.drain();
    vi.advanceTimersByTime(DEFAULT_FLUSH_INTERVAL_MS);

    // No auto-flush of the already-drained events after the interval elapses.
    expect(batches).toHaveLength(0);
  });

  test('a second drain returns an empty buffer (nothing re-sent)', () => {
    const { queue } = makeQueue();
    queue.enable();
    queue.enqueue('a');

    expect(queue.drain()).toEqual(['a']);
    expect(queue.drain()).toEqual([]);
  });
});
