import { afterEach, describe, expect, test, vi } from 'vitest';
import type { NeutralFetchResponse } from 'analytics-kit';
import {
  DEFAULT_BATCH_SCOPE,
  DEFAULT_BURST_LIMIT,
  DEFAULT_EVENTS_PER_SECOND,
  RateLimiter,
  SERVER_COOLOFF_MS,
  type BackPressureInterpreter,
  type BackPressureSignal,
} from './rate-limiter';

afterEach(() => {
  vi.useRealTimers();
});

// A controllable clock so the bucket refill + cool-off expiry are deterministic
// without leaning on wall time. Starts at 0 and advances explicitly.
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

// A back-pressure interpreter that never signals — the default for bucket-only tests.
const neverLimited: BackPressureInterpreter = async () => [];

function makeResponse(): NeutralFetchResponse {
  return { status: 200, text: async () => '', json: async () => ({}) };
}

describe('RateLimiter — client token bucket (10/s, burst 100)', () => {
  test('exposes the ported reference rates', () => {
    expect(DEFAULT_EVENTS_PER_SECOND).toBe(10);
    expect(DEFAULT_BURST_LIMIT).toBe(100);
  });

  test('grants the full burst up front, then throttles the (burst+1)th event', () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ interpretBackPressure: neverLimited, now: clock.now });

    // The bucket starts full at the burst ceiling — 100 events pass with no elapsed time.
    for (let i = 0; i < DEFAULT_BURST_LIMIT; i += 1) {
      expect(limiter.consumeToken()).toBe(true);
    }
    // The 101st, with the bucket drained and no refill time, is throttled.
    expect(limiter.consumeToken()).toBe(false);
  });

  test('refills at 10 tokens/second — 1s of elapsed time grants exactly 10 more', () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ interpretBackPressure: neverLimited, now: clock.now });

    // Drain the burst.
    for (let i = 0; i < DEFAULT_BURST_LIMIT; i += 1) {
      limiter.consumeToken();
    }
    expect(limiter.consumeToken()).toBe(false);

    // One second refills 10 tokens (10/s) — exactly 10 events pass, the 11th throttles.
    clock.advance(1000);
    for (let i = 0; i < DEFAULT_EVENTS_PER_SECOND; i += 1) {
      expect(limiter.consumeToken()).toBe(true);
    }
    expect(limiter.consumeToken()).toBe(false);
  });

  test('a fraction of a second grants a fraction of a token — 100ms alone is not enough for a whole token', () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ interpretBackPressure: neverLimited, now: clock.now });
    for (let i = 0; i < DEFAULT_BURST_LIMIT; i += 1) {
      limiter.consumeToken();
    }

    // 100ms at 10/s = 1.0 token — right at the boundary, so it passes.
    clock.advance(100);
    expect(limiter.consumeToken()).toBe(true);
    // Immediately after, 0 elapsed → still empty → throttled.
    expect(limiter.consumeToken()).toBe(false);
    // 50ms at 10/s = 0.5 token → below 1 → still throttled.
    clock.advance(50);
    expect(limiter.consumeToken()).toBe(false);
  });

  test('refill is capped at the burst ceiling — a long idle does not over-fill', () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ interpretBackPressure: neverLimited, now: clock.now });
    limiter.consumeToken(); // spend 1

    // An hour idle would refill 36,000 tokens uncapped; the ceiling holds it to 100.
    clock.advance(60 * 60 * 1000);
    for (let i = 0; i < DEFAULT_BURST_LIMIT; i += 1) {
      expect(limiter.consumeToken()).toBe(true);
    }
    expect(limiter.consumeToken()).toBe(false);
  });

  test('throttles a runaway loop under fake timers at the ported rate', () => {
    vi.useFakeTimers();
    // Default clock (Date.now-backed) driven by fake timers — the story's fake-timer path.
    const limiter = new RateLimiter({ interpretBackPressure: neverLimited });

    let passed = 0;
    // A runaway loop firing 1000 events in a tight loop (no time advancing) is
    // bounded to the burst.
    for (let i = 0; i < 1000; i += 1) {
      if (limiter.consumeToken()) passed += 1;
    }
    expect(passed).toBe(DEFAULT_BURST_LIMIT);

    // After 1s of (faked) elapsed time, exactly 10 more events pass.
    vi.advanceTimersByTime(1000);
    let refilled = 0;
    for (let i = 0; i < 1000; i += 1) {
      if (limiter.consumeToken()) refilled += 1;
    }
    expect(refilled).toBe(DEFAULT_EVENTS_PER_SECOND);
  });

  test('honours a custom burst limit, floored at eventsPerSecond', () => {
    const clock = fakeClock();
    // burstLimit below eventsPerSecond is floored up to eventsPerSecond.
    const limiter = new RateLimiter({
      interpretBackPressure: neverLimited,
      eventsPerSecond: 5,
      burstLimit: 2,
      now: clock.now,
    });
    let passed = 0;
    for (let i = 0; i < 100; i += 1) {
      if (limiter.consumeToken()) passed += 1;
    }
    expect(passed).toBe(5);
  });
});

describe('RateLimiter — server cool-off window', () => {
  test('a scope with no armed cool-off is never limited', () => {
    const limiter = new RateLimiter({ interpretBackPressure: neverLimited });
    expect(limiter.isCoolingOff(DEFAULT_BATCH_SCOPE)).toBe(false);
    expect(limiter.isCoolingOff('some-other-scope')).toBe(false);
  });

  test('a back-pressure signal arms the named scope for the cool-off window, then it expires', async () => {
    const clock = fakeClock();
    const limitOnce: BackPressureInterpreter = async () => [
      { scope: DEFAULT_BATCH_SCOPE, cooloffMs: SERVER_COOLOFF_MS },
    ];
    const limiter = new RateLimiter({ interpretBackPressure: limitOnce, now: clock.now });

    await limiter.interpretBackPressure(makeResponse());
    // Inside the window — cooling off.
    expect(limiter.isCoolingOff(DEFAULT_BATCH_SCOPE)).toBe(true);
    // One ms short of the deadline — still cooling off.
    clock.advance(SERVER_COOLOFF_MS - 1);
    expect(limiter.isCoolingOff(DEFAULT_BATCH_SCOPE)).toBe(true);
    // At/after the deadline — window elapsed, sending resumes.
    clock.advance(1);
    expect(limiter.isCoolingOff(DEFAULT_BATCH_SCOPE)).toBe(false);
  });

  test('only the scope(s) the interpreter names are cooled off', async () => {
    const namesOneScope: BackPressureInterpreter = async () => [
      { scope: 'stream-a', cooloffMs: SERVER_COOLOFF_MS },
    ];
    const limiter = new RateLimiter({ interpretBackPressure: namesOneScope });

    await limiter.interpretBackPressure(makeResponse());
    expect(limiter.isCoolingOff('stream-a')).toBe(true);
    expect(limiter.isCoolingOff('stream-b')).toBe(false);
    expect(limiter.isCoolingOff(DEFAULT_BATCH_SCOPE)).toBe(false);
  });

  test('an interpreter that signals nothing arms no cool-off (the common no-back-pressure case)', async () => {
    const limiter = new RateLimiter({ interpretBackPressure: neverLimited });
    await limiter.interpretBackPressure(makeResponse());
    expect(limiter.isCoolingOff(DEFAULT_BATCH_SCOPE)).toBe(false);
  });
});

describe('RateLimiter — injected interpreter is the swappable [WIRE] seam (bar A)', () => {
  // A second adapter's back-pressure signal is a DIFFERENT shape (a numeric
  // retry-after-ms field on the JSON body, not a scope list). It slots in by
  // constructing the same RateLimiter with a different interpreter — the bucket,
  // the cool-off map, and isCoolingOff are all untouched.
  test('a different backend signal drives the same cool-off with zero limiter change', async () => {
    const retryAfterInterpreter: BackPressureInterpreter = async (
      response
    ): Promise<BackPressureSignal[]> => {
      const body = JSON.parse(await response.text()) as { retry_after_ms?: number };
      if (body.retry_after_ms === undefined) {
        return [];
      }
      return [{ scope: DEFAULT_BATCH_SCOPE, cooloffMs: body.retry_after_ms }];
    };

    const clock = fakeClock();
    const limiter = new RateLimiter({
      interpretBackPressure: retryAfterInterpreter,
      now: clock.now,
    });

    const response: NeutralFetchResponse = {
      status: 200,
      text: async () => JSON.stringify({ retry_after_ms: 5000 }),
      json: async () => ({ retry_after_ms: 5000 }),
    };
    await limiter.interpretBackPressure(response);

    // The SAME isCoolingOff gate honours the different signal's window (5s here).
    expect(limiter.isCoolingOff(DEFAULT_BATCH_SCOPE)).toBe(true);
    clock.advance(5000);
    expect(limiter.isCoolingOff(DEFAULT_BATCH_SCOPE)).toBe(false);
  });
});
