// The retry scheduler: an in-memory queue of batches owed a re-send after a
// transient delivery failure. De-branded from the reference retry-queue
// (exponential backoff + jitter, network/5xx-only, online/offline gating, a
// single poller). It is transport-FREE — it never POSTs, resolves a URL, or reads
// a response status. The adapter owns the retry DECISION (which responses warrant
// a retry) and injects a `send` that re-runs the whole delivery for a held batch;
// this module owns only WHEN to re-run it and how long to wait.
//
// This mirrors the request-queue split: the pure scheduler holds the batches, the
// adapter-supplied `send` owns the wire. That seam is what lets the unload slice
// (S6) drain the held batches to a beacon and the offline-persistence slice (S9)
// durably mirror them — both wire into the public `drain()` / `snapshot()` entry
// points without reaching this module's private queue.

// Backoff base: doubled per retry, capped, then given ±50% jitter — a range of
// base up to (cap + 50%). Ported from the reference `3000 * 2**n`, cap 30 min.
const BACKOFF_BASE_MS = 3000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;

// Retry budgets: a normal transient failure (5xx) retries up to 10 times; a
// status-0 (no HTTP response reached — network error / blocked / CORS) is far more
// likely a hard local problem, so it gets a shorter budget of 3.
export const DEFAULT_MAX_RETRIES = 10;
export const STATUS_ZERO_MAX_RETRIES = 3;

// The poll cadence: the resolution at which the queue notices a batch's `retryAt`
// has passed. Distinct from the per-batch backoff DELAY — the poller re-checks all
// held batches every tick and re-sends the ones now due.
const POLL_INTERVAL_MS = 3000;

/**
 * A jittered exponential backoff delay in ms for the Nth retry already performed.
 * `base * 2**n` capped, then ±50% of the capped value. `random` is injectable so
 * the backoff is deterministic under test (a stub of `() => 0.5` yields exactly
 * the capped value — zero jitter).
 */
export function pickNextRetryDelay(
  retriesPerformedSoFar: number,
  random: () => number = Math.random
): number {
  const rawBackoff = BACKOFF_BASE_MS * 2 ** retriesPerformedSoFar;
  const capped = Math.min(MAX_BACKOFF_MS, rawBackoff);
  const minBackoff = capped / 2;
  const jitterFraction = random() - 0.5; // [-0.5, 0.5]
  const jitter = jitterFraction * (capped - minBackoff);
  return Math.ceil(capped + jitter);
}

/**
 * Whether a delivery response is TRANSIENT and warrants a retry (mirrors node's
 * send-batch.ts isTransientStatus): a network error (status 0), a 408 request-timeout,
 * a 429 rate-limit, or any 5xx. Everything else — a 2xx success, a 3xx redirect, and
 * every other 4xx — is terminal and is NEVER retried (a re-send would either duplicate a
 * delivered batch or hammer a permanent rejection).
 */
export function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

/** The per-status retry budget: a shorter one for status-0 network failures. */
export function maxRetriesForStatus(status: number): number {
  return status === 0 ? STATUS_ZERO_MAX_RETRIES : DEFAULT_MAX_RETRIES;
}

interface RetryElement<T> {
  retryAt: number;
  attempt: number;
  batch: T[];
}

export interface RetryQueueOptions<T> {
  // The adapter-owned re-delivery. Re-runs the WHOLE send (assemble + POST +
  // status inspection) for a held batch; the adapter re-enqueues here on another
  // transient failure. `attempt` is the number of retries already performed for
  // this batch so the adapter can honour the per-status retry budget and advance
  // the backoff. Returns a promise so a rejection is swallowed like the
  // request-queue's send boundary — a failed retry never escapes the poller.
  send: (batch: T[], attempt: number) => Promise<void>;
  // Injectable jitter for deterministic backoff under test; defaults to Math.random.
  random?: () => number;
  // Injectable online read; defaults to the defensive navigator.onLine probe. A
  // non-DOM (SSR/test) context with no navigator is treated as online.
  isOnline?: () => boolean;
}

function defaultIsOnline(): boolean {
  // Defensive navigator read: DOM-typed under lib:["ES2022","DOM"], but safe in a
  // non-DOM test/SSR context (mirrors consent.ts / the adapter's bot probe). No
  // navigator, or no onLine field, is treated as online.
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  if (nav === undefined || !('onLine' in nav)) {
    return true;
  }
  return nav.onLine;
}

export class RetryQueue<T> {
  private readonly send: (batch: T[], attempt: number) => Promise<void>;
  private readonly random: () => number;
  private readonly isOnline: () => boolean;

  private queue: RetryElement<T>[] = [];
  private polling = false;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private online: boolean;
  private readonly onlineListener: (() => void) | undefined;
  private readonly offlineListener: (() => void) | undefined;

  constructor(options: RetryQueueOptions<T>) {
    this.send = options.send;
    this.random = options.random ?? Math.random;
    this.isOnline = options.isOnline ?? defaultIsOnline;
    this.online = this.isOnline();

    // Bind online/offline listeners so a reconnect drains what accumulated while
    // offline, and a disconnect pauses re-sends. Guarded for the non-DOM context.
    const win = typeof window === 'undefined' ? undefined : window;
    if (win !== undefined) {
      this.onlineListener = () => {
        this.online = true;
        this.flushDue();
      };
      this.offlineListener = () => {
        this.online = false;
      };
      win.addEventListener('online', this.onlineListener);
      win.addEventListener('offline', this.offlineListener);
    }
  }

  get length(): number {
    return this.queue.length;
  }

  // Schedule a failed batch for its next jittered retry. `attempt` is the number of
  // retries ALREADY performed for this batch (0 for the first failure). The caller
  // has already checked isRetryableStatus + the budget; this only schedules.
  scheduleRetry(batch: T[], attempt: number): void {
    const delay = pickNextRetryDelay(attempt, this.random);
    this.queue.push({ retryAt: Date.now() + delay, attempt: attempt + 1, batch });
    this.startPolling();
  }

  // Re-hold a batch WITHOUT consuming its retry/backoff budget — for a non-failure hold
  // (e.g. a server cool-off): the send never reached the wire, so the failure count must
  // NOT advance. Re-enqueues at the SAME `attempt` with a fixed one-poll delay, so the
  // poller re-checks it shortly (re-holding again while the hold persists) rather than
  // growing an exponential backoff. Distinct from scheduleRetry, which stores attempt+1.
  rehold(batch: T[], attempt: number): void {
    this.queue.push({ retryAt: Date.now() + POLL_INTERVAL_MS, attempt, batch });
    this.startPolling();
  }

  // A non-destructive read of the held batches (retry order preserved). The
  // offline-persistence slice (S9) mirrors this to durable storage; it does not
  // clear the queue or touch the poller. Returns a fresh outer array so a
  // concurrent retry completion can't mutate what a caller is mid-read on.
  snapshot(): ReadonlyArray<ReadonlyArray<T>> {
    return this.queue.map((element) => element.batch);
  }

  // Take ALL held batches and tear the queue down: stop the poller, unbind the
  // online/offline listeners, clear the queue. The unload slice (S6) calls this and
  // beacon-sends each returned batch — the beacon transport is S6's concern, so this
  // returns the batches rather than sending them (staying transport-free).
  drain(): ReadonlyArray<ReadonlyArray<T>> {
    const drained = this.queue.map((element) => element.batch);
    this.queue = [];
    this.stopPolling();
    this.unbindListeners();
    return drained;
  }

  // DISCARD every held batch and tear the queue down — same teardown as drain() but
  // WITHOUT returning the batches: the opt-out path calls this so held batches are
  // dropped (never re-POSTed) and the poller can't wake to re-send after a denial.
  clear(): void {
    this.queue = [];
    this.stopPolling();
    this.unbindListeners();
  }

  private startPolling(): void {
    if (this.polling) {
      return;
    }
    this.polling = true;
    this.poll();
  }

  private poll(): void {
    this.clearPollTimer();
    // Stop polling when the queue empties; the next scheduleRetry restarts it. This
    // keeps an idle queue from holding a live timer (and, under fake timers, from
    // advancing time forever).
    if (this.queue.length === 0) {
      this.polling = false;
      return;
    }
    this.pollTimer = setTimeout(() => {
      if (this.online) {
        this.flushDue();
      }
      this.poll();
    }, POLL_INTERVAL_MS);
  }

  // Re-send every batch whose retryAt has passed; hold the rest. Only fires while
  // online — an offline gate holds all retries until reconnect.
  private flushDue(): void {
    if (!this.online) {
      return;
    }
    const now = Date.now();
    const due: RetryElement<T>[] = [];
    const held: RetryElement<T>[] = [];
    for (const element of this.queue) {
      if (element.retryAt <= now) {
        due.push(element);
      } else {
        held.push(element);
      }
    }
    this.queue = held;
    for (const element of due) {
      // Swallow a rejection so a failed retry send never escapes the poller; the
      // adapter's send re-enqueues via scheduleRetry on another transient failure.
      void this.send(element.batch, element.attempt).catch(() => undefined);
    }
  }

  private stopPolling(): void {
    this.polling = false;
    this.clearPollTimer();
  }

  private clearPollTimer(): void {
    if (this.pollTimer !== undefined) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private unbindListeners(): void {
    const win = typeof window === 'undefined' ? undefined : window;
    if (win === undefined) {
      return;
    }
    if (this.onlineListener !== undefined) {
      win.removeEventListener('online', this.onlineListener);
    }
    if (this.offlineListener !== undefined) {
      win.removeEventListener('offline', this.offlineListener);
    }
  }
}
