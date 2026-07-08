// The batch buffer: a paused-at-start, time-based queue that groups captured
// events and hands a batch to a supplied send-fn on the EARLIER of an elapsed
// flush interval OR a size threshold. De-branded from the reference
// request-queue (interval + clamp + paused-start) composed with the core
// stateless path's size trigger (flushAt) for parity with the node target.
//
// It is a PURE buffer: it owns WHEN to flush and never knows about URLs, the
// wire envelope, or transport. The adapter supplies `send`, which owns the POST
// (envelope + fetch + ingest target). That seam is what lets later transport
// slices wrap the send-fn (retry) or the POST site (rate-limit, compression)
// and the buffer boundary (offline mirror) without reshaping this module.

// The reference default flush interval, clamped to a sane window so a
// misconfigured value can neither hammer the network nor stall delivery.
export const DEFAULT_FLUSH_INTERVAL_MS = 3000;
const MIN_FLUSH_INTERVAL_MS = 250;
const MAX_FLUSH_INTERVAL_MS = 5000;

// The size trigger default (node/core parity). A batch of this many buffered
// events flushes immediately regardless of the interval.
export const DEFAULT_FLUSH_AT = 20;

function clampInterval(value: number | undefined): number {
  const raw = value ?? DEFAULT_FLUSH_INTERVAL_MS;
  if (!Number.isFinite(raw)) {
    return DEFAULT_FLUSH_INTERVAL_MS;
  }
  return Math.min(Math.max(raw, MIN_FLUSH_INTERVAL_MS), MAX_FLUSH_INTERVAL_MS);
}

function clampFlushAt(value: number | undefined): number {
  const raw = value ?? DEFAULT_FLUSH_AT;
  if (!Number.isFinite(raw)) {
    return DEFAULT_FLUSH_AT;
  }
  // A floor of 1 so a misconfigured 0 can never wedge the queue (it would never
  // reach the threshold and only the interval would ever fire).
  return Math.max(Math.floor(raw), 1);
}

export interface RequestQueueOptions<T> {
  // The adapter-owned batch delivery. Returns a promise so an explicit
  // `flushNow()` can await the in-flight POST; the interval/size auto-flush does
  // not block on it (fire-and-forget), but its settlement is tracked so an
  // explicit flush coalesces with any auto-flush already on the wire.
  send: (batch: T[]) => Promise<void>;
  flushInterval?: number;
  flushAt?: number;
}

export class RequestQueue<T> {
  private readonly send: (batch: T[]) => Promise<void>;
  private readonly flushIntervalMs: number;
  private readonly flushAt: number;

  // Starts paused (mirrors the reference): buffered events accumulate but the
  // interval does not arm until enabled. capture() enables the queue on first use.
  private paused = true;
  private buffer: T[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  // In-flight send promises tracked so `flushNow()` resolves only after the drain
  // it triggers AND any auto-flush POST already on the wire have settled.
  private readonly inFlight = new Set<Promise<void>>();

  constructor(options: RequestQueueOptions<T>) {
    this.send = options.send;
    this.flushIntervalMs = clampInterval(options.flushInterval);
    this.flushAt = clampFlushAt(options.flushAt);
  }

  enable(): void {
    this.paused = false;
    this.armTimer();
  }

  enqueue(item: T): void {
    this.buffer.push(item);
    if (this.buffer.length >= this.flushAt) {
      // The size trigger fires now; clear any armed interval so it does not fire a
      // redundant near-empty batch a moment later. The next enqueue re-arms it.
      this.drainAndSend();
      return;
    }
    this.armTimer();
  }

  // Force an immediate drain and resolve once the triggered POST — and any
  // auto-flush POST still on the wire — settle. Used by the adapter's flush() SPI.
  async flushNow(): Promise<void> {
    this.drainAndSend();
    await Promise.allSettled([...this.inFlight]);
  }

  // Drop the unsent buffer WITHOUT flushing (the opt-out contract). The interval
  // is cleared so a pending timer cannot resurrect a flush of already-dropped events.
  drop(): void {
    this.buffer = [];
    this.clearTimer();
  }

  // Take ALL buffered events and clear the queue WITHOUT sending — mirrors
  // RetryQueue.drain(). The unload slice (S6) calls this and beacon-sends the returned
  // events; the beacon transport is the adapter's concern, so this stays transport-free
  // (it never touches `send`). The interval is cleared so a pending timer cannot fire a
  // redundant flush of events already handed to the beacon.
  drain(): T[] {
    const drained = this.buffer;
    this.buffer = [];
    this.clearTimer();
    return drained;
  }

  private armTimer(): void {
    if (this.paused || this.flushTimer !== undefined || this.buffer.length === 0) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.drainAndSend();
    }, this.flushIntervalMs);
  }

  private drainAndSend(): void {
    this.clearTimer();
    if (this.buffer.length === 0) {
      return;
    }
    const batch = this.buffer;
    this.buffer = [];
    // Track the send so flushNow() can await it; swallow a rejection so an interval
    // auto-flush failure never escapes the timer callback (S3 owns retry).
    const pending = this.send(batch)
      .catch(() => undefined)
      .finally(() => {
        this.inFlight.delete(pending);
      });
    this.inFlight.add(pending);
  }

  private clearTimer(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }
}
