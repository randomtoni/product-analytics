// The server-side batch buffer: an in-memory queue that accumulates captured
// events and hands them to a supplied send-fn on the EARLIER of an elapsed flush
// interval OR a size threshold. A fresh de-brand of the reference stateless
// enqueue/flush path (size + interval trigger, drop-oldest at a queue cap,
// maxBatchSize slicing into per-delivery batches) — NOT the browser RequestQueue,
// which is browser-saturated and carries no queue-cap/drop-oldest overflow.
//
// It is a PURE buffer: it owns WHEN and HOW MUCH to flush and never knows about
// URLs, the wire envelope, or transport. The owner supplies `send`, which owns
// the delivery. That seam lets the wire delivery slot in behind the same closure
// and lets the lifecycle verbs force a drain — without reshaping this module.
//
// The size trigger schedules a DEFERRED drain (a 0ms timer), not an inline one, so a
// synchronous burst accumulates in the buffer before the drain runs — which is what
// lets the drop-oldest cap and multi-batch slicing be reached (mirrors the reference,
// whose size-triggered flush is an async `void this.flush()`).

export const DEFAULT_FLUSH_AT = 20;
export const DEFAULT_FLUSH_INTERVAL_MS = 10000;
export const DEFAULT_MAX_BATCH_SIZE = 100;
export const DEFAULT_MAX_QUEUE_SIZE = 1000;

export interface BatchQueueOptions<T> {
  // The owner-supplied batch delivery. Called once per maxBatchSize-sliced batch;
  // a backlog larger than maxBatchSize produces multiple calls in one flush.
  send: (batch: T[]) => Promise<void>;
  flushAt?: number;
  flushInterval?: number;
  maxBatchSize?: number;
  maxQueueSize?: number;
}

export class BatchQueue<T> {
  private readonly send: (batch: T[]) => Promise<void>;
  private readonly flushAt: number;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly maxQueueSize: number;

  private buffer: T[] = [];
  private intervalTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingFlush: ReturnType<typeof setTimeout> | undefined;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(options: BatchQueueOptions<T>) {
    this.send = options.send;
    // A falsy flushAt (0/undefined) falls back to the default, then floors at 1 — a
    // misconfigured threshold can never wedge the queue (it would never be reached and
    // only the interval would ever fire).
    this.flushAt = Math.max(Math.floor(options.flushAt || DEFAULT_FLUSH_AT), 1);
    this.flushIntervalMs = options.flushInterval ?? DEFAULT_FLUSH_INTERVAL_MS;
    // maxBatchSize is an INDEPENDENT per-delivery cap (floored at 1), deliberately NOT
    // clamped to flushAt: flushAt=250 + maxBatchSize=100 is a legitimate "buffer deep,
    // cap each delivery" config that slices a 250-event flush into 100/100/50.
    this.maxBatchSize = Math.max(options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE, 1);
    // maxQueueSize IS floored at flushAt: a cap below the flush threshold would drop-
    // oldest before the size trigger could ever fire, wedging into a never-size-flush state.
    this.maxQueueSize = Math.max(options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE, this.flushAt);
  }

  enqueue(item: T): void {
    if (this.buffer.length >= this.maxQueueSize) {
      this.buffer.shift();
    }
    this.buffer.push(item);

    if (this.buffer.length >= this.flushAt) {
      // The size trigger schedules a deferred drain (not inline) so a synchronous burst
      // keeps accumulating — the source of the drop-oldest and multi-batch behaviors.
      this.scheduleFlush();
      return;
    }
    this.armInterval();
  }

  // Force an immediate drain and resolve once every triggered delivery — and any
  // auto-flush delivery still in flight — settles. The lifecycle verbs (E7-S6) use it.
  async flushNow(): Promise<void> {
    this.drainAndSend();
    await Promise.allSettled([...this.inFlight]);
  }

  // Take ALL buffered events and clear the queue WITHOUT sending; clear the timers so
  // no pending tick can resurrect a flush of already-drained events. The quiesce path
  // (E7-S6) uses it.
  drain(): T[] {
    const drained = this.buffer;
    this.buffer = [];
    this.clearTimers();
    return drained;
  }

  private armInterval(): void {
    if (this.intervalTimer !== undefined || this.pendingFlush !== undefined) {
      return;
    }
    if (this.buffer.length === 0) {
      return;
    }
    this.intervalTimer = setTimeout(() => {
      this.drainAndSend();
    }, this.flushIntervalMs);
  }

  private scheduleFlush(): void {
    if (this.pendingFlush !== undefined) {
      return;
    }
    this.pendingFlush = setTimeout(() => {
      this.drainAndSend();
    }, 0);
  }

  // The single drain path every trigger routes through: clears both timers at the top
  // (so no stale tick fires against an emptied buffer), slices the buffer into
  // maxBatchSize batches, and calls `send` once per batch.
  private drainAndSend(): void {
    this.clearTimers();
    if (this.buffer.length === 0) {
      return;
    }
    const pending = this.buffer;
    this.buffer = [];
    for (let i = 0; i < pending.length; i += this.maxBatchSize) {
      const batch = pending.slice(i, i + this.maxBatchSize);
      this.track(this.send(batch));
    }
  }

  private track(promise: Promise<void>): void {
    const tracked = promise
      .catch(() => undefined)
      .finally(() => {
        this.inFlight.delete(tracked);
      });
    this.inFlight.add(tracked);
  }

  private clearTimers(): void {
    if (this.intervalTimer !== undefined) {
      clearTimeout(this.intervalTimer);
      this.intervalTimer = undefined;
    }
    if (this.pendingFlush !== undefined) {
      clearTimeout(this.pendingFlush);
      this.pendingFlush = undefined;
    }
  }
}
