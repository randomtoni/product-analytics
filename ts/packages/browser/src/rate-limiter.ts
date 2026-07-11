import type { NeutralFetchResponse } from '@randomtoni/analytics-kit';

// The client rate limiter: a token bucket that throttles capture PROACTIVELY, plus
// a per-scope server cool-off that honours a back-pressure signal the backend
// sends. De-branded from the reference rate-limiter (token bucket 10 events/s,
// burst ×10; server-side limit read from the response and held for a cool-off
// window). Two independent responsibilities, one policy surface — the client
// bucket never touches the cool-off map and vice versa.
//
// The ONE wire-coupled part — how a given backend spells its back-pressure
// signal — is injected as a `BackPressureInterpreter`, never baked in. The bucket
// math, the cool-off map, the gate, and the window are all transport-agnostic and
// identical across adapters; a second adapter swaps only the interpreter (a
// different response field, a different body shape) with zero change to anything
// else here (bar A). No vendor field name lives on this module's surface.

// Ported reference rates: 10 events/s sustained, burst ×10 = a 100-token bucket.
export const DEFAULT_EVENTS_PER_SECOND = 10;
const BURST_LIMIT_MULTIPLIER = 10;
export const DEFAULT_BURST_LIMIT = DEFAULT_EVENTS_PER_SECOND * BURST_LIMIT_MULTIPLIER;

// Ported cool-off window: a scope named by a back-pressure signal is held for one
// minute before its next send is attempted.
export const SERVER_COOLOFF_MS = 60 * 1000;

// The single scope a one-endpoint adapter partitions its back-pressure by. The
// cool-off map is keyed by scope so a backend whose signal names finer scopes (a
// per-stream / per-endpoint back-pressure) slots in without reshaping the gate —
// this adapter simply only ever emits the one default key. Neutral by role; NOT a
// backend product name.
export const DEFAULT_BATCH_SCOPE = 'default';

// A neutral back-pressure directive: which scope to cool off, and for how long.
// The interpreter returns these; the limiter applies them. Keeping the return
// type neutral (scope + ms, not a raw backend field) is what stops any one
// backend's response vocabulary from becoming the interpreter contract.
export interface BackPressureSignal {
  scope: string;
  cooloffMs: number;
}

// The [WIRE] seam: read whatever back-pressure signal a backend sends off the
// neutral fetch response and translate it to neutral directives. Injected per
// adapter — the ONLY place a backend's on-the-wire signal name appears. Returns an
// empty list when the response carries no back-pressure.
export type BackPressureInterpreter = (
  response: NeutralFetchResponse
) => Promise<BackPressureSignal[]>;

export interface RateLimiterOptions {
  eventsPerSecond?: number;
  burstLimit?: number;
  interpretBackPressure: BackPressureInterpreter;
  // Injectable clock for deterministic bucket refill + cool-off expiry under test;
  // defaults to Date.now.
  now?: () => number;
}

interface Bucket {
  tokens: number;
  last: number;
}

export class RateLimiter {
  private readonly eventsPerSecond: number;
  private readonly burstLimit: number;
  private readonly interpret: BackPressureInterpreter;
  private readonly now: () => number;

  // The client token bucket: starts full (burst tokens) and refills at
  // eventsPerSecond, capped at the burst ceiling. Each captured event spends one
  // token; an empty bucket throttles.
  private bucket: Bucket;
  // Per-scope cool-off deadlines: a scope is rate-limited by the server until its
  // stored timestamp passes. Absent = not limited.
  private serverCooloffs: Record<string, number> = {};

  constructor(options: RateLimiterOptions) {
    this.eventsPerSecond = options.eventsPerSecond ?? DEFAULT_EVENTS_PER_SECOND;
    this.burstLimit = Math.max(options.burstLimit ?? DEFAULT_BURST_LIMIT, this.eventsPerSecond);
    this.interpret = options.interpretBackPressure;
    this.now = options.now ?? (() => Date.now());
    this.bucket = { tokens: this.burstLimit, last: this.now() };
  }

  // Refill the bucket for elapsed time, then spend one token if available. Returns
  // true when a token was granted (the event proceeds), false when the bucket is
  // empty (the event is throttled — dropped before it enters the queue). A runaway
  // loop is bounded to burst + eventsPerSecond·elapsed.
  consumeToken(): boolean {
    const now = this.now();
    this.bucket.tokens += ((now - this.bucket.last) / 1000) * this.eventsPerSecond;
    this.bucket.last = now;
    if (this.bucket.tokens > this.burstLimit) {
      this.bucket.tokens = this.burstLimit;
    }
    if (this.bucket.tokens < 1) {
      return false;
    }
    this.bucket.tokens = Math.max(0, this.bucket.tokens - 1);
    return true;
  }

  // Whether a scope is inside its server cool-off window (its next send should be
  // skipped). A scope with no stored deadline, or one whose deadline has passed, is
  // not limited.
  isCoolingOff(scope: string): boolean {
    const until = this.serverCooloffs[scope];
    if (until === undefined) {
      return false;
    }
    return this.now() < until;
  }

  // Read the backend's back-pressure signal off a completed response (via the
  // injected interpreter) and arm the named scopes' cool-off windows. Called for
  // every COMPLETED response regardless of status — back-pressure is orthogonal to
  // the status-based retry decision (a 200 may carry it; a 5xx may co-exist with it).
  // A network throw propagates before this runs — there is no body to interpret.
  async interpretBackPressure(response: NeutralFetchResponse): Promise<void> {
    const signals = await this.interpret(response);
    const now = this.now();
    for (const signal of signals) {
      this.serverCooloffs[signal.scope] = now + signal.cooloffMs;
    }
  }
}
