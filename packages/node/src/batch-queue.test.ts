import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  BatchQueue,
  DEFAULT_FLUSH_AT,
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_MAX_BATCH_SIZE,
  DEFAULT_MAX_QUEUE_SIZE,
} from './batch-queue';

// A send spy that records every delivered batch — the real observable boundary.
function spySend() {
  const batches: number[][] = [];
  const send = vi.fn(async (batch: number[]) => {
    batches.push(batch);
  });
  return { send, batches };
}

function enqueueN(queue: BatchQueue<number>, n: number, from = 0): void {
  for (let i = 0; i < n; i++) {
    queue.enqueue(from + i);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('locked defaults', () => {
  test('all four defaults match the locked R1 values', () => {
    expect(DEFAULT_FLUSH_AT).toBe(20);
    expect(DEFAULT_FLUSH_INTERVAL_MS).toBe(10000);
    expect(DEFAULT_MAX_BATCH_SIZE).toBe(100);
    expect(DEFAULT_MAX_QUEUE_SIZE).toBe(1000);
  });
});

describe('size trigger (flushAt)', () => {
  // The size trigger schedules a DEFERRED drain (0ms timer), so delivery lands on the
  // next timer tick, not inline — advance timers to observe it.
  test('enqueuing flushAt (default 20) events triggers a flush', () => {
    const { send, batches } = spySend();
    const queue = new BatchQueue<number>({ send });

    enqueueN(queue, 19);
    vi.advanceTimersByTime(0);
    expect(send).not.toHaveBeenCalled();

    queue.enqueue(19); // the 20th → size trigger
    vi.advanceTimersByTime(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(batches[0]).toHaveLength(20);
  });

  test('fewer than flushAt buffered does NOT size-trigger before the interval', () => {
    const { send } = spySend();
    const queue = new BatchQueue<number>({ send });

    enqueueN(queue, 19);
    vi.advanceTimersByTime(0);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('interval trigger (flushInterval)', () => {
  test('a sub-flushAt buffer flushes after flushInterval elapses', () => {
    const { send, batches } = spySend();
    const queue = new BatchQueue<number>({ send, flushInterval: 10000 });

    queue.enqueue(1);
    vi.advanceTimersByTime(9999);
    expect(send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(batches[0]).toEqual([1]);
  });

  test('the default interval is 10000ms', () => {
    const { send } = spySend();
    const queue = new BatchQueue<number>({ send });

    queue.enqueue(1);
    vi.advanceTimersByTime(9999);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('no timer arms while the buffer is empty', () => {
    const { send } = spySend();
    new BatchQueue<number>({ send, flushInterval: 100 });

    vi.advanceTimersByTime(1000);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('earlier-of size vs interval', () => {
  test('a size trigger fires before the interval and cancels the pending interval', () => {
    const { send } = spySend();
    const queue = new BatchQueue<number>({ send, flushAt: 3, flushInterval: 10000 });

    queue.enqueue(1);
    queue.enqueue(2);
    vi.advanceTimersByTime(5000); // interval half-elapsed, not yet fired
    expect(send).not.toHaveBeenCalled();

    queue.enqueue(3); // size trigger schedules the deferred drain (the earlier of the two)
    vi.advanceTimersByTime(0);
    expect(send).toHaveBeenCalledTimes(1);

    // The interval that was armed must have been cleared — advancing past it does
    // not fire a redundant empty flush.
    vi.advanceTimersByTime(10000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('the interval fires when the size threshold is never reached', () => {
    const { send } = spySend();
    const queue = new BatchQueue<number>({ send, flushAt: 5, flushInterval: 1000 });

    queue.enqueue(1);
    queue.enqueue(2); // below flushAt
    vi.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('overflow: drop-oldest at maxQueueSize', () => {
  // A synchronous burst past maxQueueSize accumulates before the DEFERRED size-flush
  // runs, so drop-oldest fires on enqueue. Here flushAt == maxQueueSize so the drain is
  // scheduled but has not yet emptied the buffer when the overflow drops kick in.
  test('enqueuing past maxQueueSize drops the OLDEST buffered event', () => {
    const { send, batches } = spySend();
    const queue = new BatchQueue<number>({ send, maxQueueSize: 3, flushAt: 3, maxBatchSize: 100 });

    enqueueN(queue, 5, 1); // 1..5; cap=3 drops 1 then 2 → buffer holds [3,4,5] at drain
    vi.advanceTimersByTime(0);

    expect(batches.flat()).toEqual([3, 4, 5]);
  });

  test('a burst well past the cap keeps only the newest maxQueueSize survivors', () => {
    const { send, batches } = spySend();
    const queue = new BatchQueue<number>({ send, maxQueueSize: 5, flushAt: 5, maxBatchSize: 100 });

    enqueueN(queue, 8, 1); // 1..8; cap=5 → drop 1,2,3 → [4,5,6,7,8]
    vi.advanceTimersByTime(0);

    expect(batches.flat()).toEqual([4, 5, 6, 7, 8]);
  });

  test('overflow never blocks and never force-flushes', () => {
    const { send } = spySend();
    const queue = new BatchQueue<number>({ send, maxQueueSize: 2, flushAt: 100 });

    enqueueN(queue, 50); // far past the cap, below flushAt
    // Overflow drops but never delivers on its own — no trigger has fired yet.
    expect(send).not.toHaveBeenCalled();
  });

  test('the default cap is 1000 and drops the oldest past it', () => {
    const { send, batches } = spySend();
    const queue = new BatchQueue<number>({
      send,
      flushAt: DEFAULT_MAX_QUEUE_SIZE,
      maxBatchSize: DEFAULT_MAX_QUEUE_SIZE,
    });

    enqueueN(queue, DEFAULT_MAX_QUEUE_SIZE + 1, 1); // 1..1001 → drop oldest (1), keep 2..1001
    vi.advanceTimersByTime(0);

    const delivered = batches.flat();
    expect(delivered).toHaveLength(DEFAULT_MAX_QUEUE_SIZE);
    expect(delivered[0]).toBe(2); // event value 1 was dropped as oldest
    expect(delivered[delivered.length - 1]).toBe(DEFAULT_MAX_QUEUE_SIZE + 1);
  });

  test('maxQueueSize floors at flushAt so the size trigger can never be starved', () => {
    const { send, batches } = spySend();
    // Request a cap below flushAt: it is floored up to flushAt (10), so 10 events
    // accumulate and size-flush rather than the cap dropping every enqueue.
    const queue = new BatchQueue<number>({ send, maxQueueSize: 2, flushAt: 10 });

    enqueueN(queue, 10, 1);
    vi.advanceTimersByTime(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(batches[0]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe('maxBatchSize slicing', () => {
  // flushAt=250 > maxBatchSize=100 is a legitimate "buffer deep, cap each delivery"
  // config: a 250-event burst accumulates, then the deferred drain slices it into
  // 100/100/50 across three send calls.
  test('a flush drains at most maxBatchSize records per delivery call (250 → 100/100/50)', () => {
    const { send, batches } = spySend();
    const queue = new BatchQueue<number>({ send, maxBatchSize: 100, flushAt: 250 });

    enqueueN(queue, 250, 1);
    vi.advanceTimersByTime(0);

    expect(send).toHaveBeenCalledTimes(3);
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
  });

  test('slicing preserves order across batches', () => {
    const { send, batches } = spySend();
    const queue = new BatchQueue<number>({ send, maxBatchSize: 2, flushAt: 5 });

    enqueueN(queue, 5, 1);
    vi.advanceTimersByTime(0);

    expect(batches).toEqual([
      [1, 2],
      [3, 4],
      [5],
    ]);
  });

  test('the default maxBatchSize is 100', () => {
    const { send, batches } = spySend();
    const queue = new BatchQueue<number>({ send, flushAt: 150 });

    enqueueN(queue, 150, 1);
    vi.advanceTimersByTime(0);

    expect(batches.map((b) => b.length)).toEqual([100, 50]);
  });

  test('maxBatchSize is independent of flushAt — NOT clamped up to it', () => {
    const { send, batches } = spySend();
    const queue = new BatchQueue<number>({ send, maxBatchSize: 100, flushAt: 300 });

    enqueueN(queue, 300, 1);
    vi.advanceTimersByTime(0);

    // If maxBatchSize were clamped up to flushAt (300) this would be one batch of 300.
    expect(batches.map((b) => b.length)).toEqual([100, 100, 100]);
  });
});

describe('config-overridable defaults', () => {
  test('flushAt override changes the size threshold', () => {
    const { send } = spySend();
    const queue = new BatchQueue<number>({ send, flushAt: 3 });

    enqueueN(queue, 2);
    vi.advanceTimersByTime(0);
    expect(send).not.toHaveBeenCalled();

    queue.enqueue(99);
    vi.advanceTimersByTime(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('flushInterval override changes the interval window', () => {
    const { send } = spySend();
    const queue = new BatchQueue<number>({ send, flushInterval: 250 });

    queue.enqueue(1);
    vi.advanceTimersByTime(250);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('maxBatchSize override changes the per-call slice size', () => {
    const { send, batches } = spySend();
    const queue = new BatchQueue<number>({ send, maxBatchSize: 10, flushAt: 25 });

    enqueueN(queue, 25, 1);
    vi.advanceTimersByTime(0);
    expect(batches.map((b) => b.length)).toEqual([10, 10, 5]);
  });

  test('maxQueueSize override changes the drop-oldest cap', () => {
    const { send, batches } = spySend();
    const queue = new BatchQueue<number>({ send, maxQueueSize: 5, flushAt: 5, maxBatchSize: 100 });

    enqueueN(queue, 8, 1); // keep last 5: [4,5,6,7,8]
    vi.advanceTimersByTime(0);
    expect(batches.flat()).toEqual([4, 5, 6, 7, 8]);
  });

  test('a misconfigured maxBatchSize of 0 is floored to 1 (never wedges the drain)', () => {
    const { send, batches } = spySend();
    const queue = new BatchQueue<number>({ send, maxBatchSize: 0, flushAt: 3 });

    enqueueN(queue, 3, 1);
    vi.advanceTimersByTime(0);
    // Floored to 1 → three single-event deliveries, never an empty-batch spin.
    expect(batches).toEqual([[1], [2], [3]]);
  });

  test('a misconfigured flushAt of 0 falls back to the default (never wedges on size)', () => {
    const { send } = spySend();
    const queue = new BatchQueue<number>({ send, flushAt: 0 });

    enqueueN(queue, DEFAULT_FLUSH_AT - 1); // 19 — below the default 20
    vi.advanceTimersByTime(0);
    expect(send).not.toHaveBeenCalled();

    queue.enqueue(99); // 20th → default size trigger fires
    vi.advanceTimersByTime(0);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('injected send seam', () => {
  test('the injected send receives the batches', () => {
    const { send, batches } = spySend();
    const queue = new BatchQueue<number>({ send, flushAt: 3 });

    enqueueN(queue, 3);
    vi.advanceTimersByTime(0);

    expect(send).toHaveBeenCalledTimes(1);
    expect(batches[0]).toEqual([0, 1, 2]);
  });

  test('flushNow drains synchronously and resolves after every delivery settles', async () => {
    let resolveDelivery: () => void = () => {};
    const send = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolveDelivery = r;
        })
    );
    const queue = new BatchQueue<number>({ send, flushAt: 5000 });

    queue.enqueue(1);
    const flushed = queue.flushNow();
    expect(send).toHaveBeenCalledTimes(1); // flushNow drains immediately, not deferred

    let settled = false;
    void flushed.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveDelivery();
    await flushed;
    expect(settled).toBe(true);
  });

  test('a send rejection does not escape the auto-flush timer callback', () => {
    const send = vi.fn(async () => {
      throw new Error('delivery failed');
    });
    const queue = new BatchQueue<number>({ send, flushInterval: 100 });

    queue.enqueue(1);
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('a size-trigger burst only schedules ONE deferred drain', () => {
    const { send } = spySend();
    const queue = new BatchQueue<number>({ send, flushAt: 3, maxBatchSize: 100 });

    // Enqueue well past flushAt in one synchronous burst; a single deferred drain
    // should ship it all in one delivery, not one drain per over-threshold enqueue.
    enqueueN(queue, 10, 1);
    vi.advanceTimersByTime(0);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('drain (quiesce handhold for E7-S6)', () => {
  test('drain returns the buffered events without sending and clears the timers', () => {
    const { send } = spySend();
    const queue = new BatchQueue<number>({ send, flushInterval: 100, flushAt: 5000 });

    enqueueN(queue, 3);
    const drained = queue.drain();
    expect(drained).toEqual([0, 1, 2]);
    expect(send).not.toHaveBeenCalled();

    // The armed interval was cleared — no delivery fires after draining.
    vi.advanceTimersByTime(1000);
    expect(send).not.toHaveBeenCalled();
  });

  test('flushNow cancels a pending deferred size-flush (no double delivery)', async () => {
    const { send, batches } = spySend();
    const queue = new BatchQueue<number>({ send, flushAt: 3, maxBatchSize: 100 });

    enqueueN(queue, 3); // schedules a deferred drain
    await queue.flushNow(); // drains now and must cancel the pending deferred drain

    vi.advanceTimersByTime(0); // the canceled deferred drain must NOT fire a 2nd delivery
    expect(send).toHaveBeenCalledTimes(1);
    expect(batches[0]).toEqual([0, 1, 2]);
  });
});
