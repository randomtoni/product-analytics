// Session-replay sampling (E14-S4). De-branded from posthog's session-recording sampling:
// a `sampleRate` in [0,1] gates a whole session, decided ONCE per session (and re-decided
// on session-id rotation) by a deterministic hash of the session id, so the same session
// always resolves the same keep/drop verdict across reloads.

// The default keep-rate: absent/invalid `sampleRate` records every session (sampling off).
const DEFAULT_SAMPLE_RATE = 1;

// Normalize the consumer's raw `sampleRate` at recorder construction, mirroring the
// browser target's shipped numeric-config precedent (`request-queue.ts` clampInterval/
// clampFlushAt): a finite value in [0,1] is used as-is; NaN / out-of-range / non-number
// falls back to the default (record ALL) with a dev warning. This is normalize-to-DEFAULT,
// NOT clamp-to-bound — clamping 1.1→1 would silently record 100% of a session the consumer
// meant to sample down (the expensive surprise). Never throws, never fails init.
export function normalizeSampleRate(raw: number | undefined): number {
  if (raw === undefined) {
    return DEFAULT_SAMPLE_RATE;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    // eslint-disable-next-line no-console
    console.warn(
      `[analytics-kit] Ignoring out-of-range session-replay sampleRate ${String(raw)}; ` +
        `expected a number in [0, 1]. Recording all sessions.`
    );
    return DEFAULT_SAMPLE_RATE;
  }
  return raw;
}

// A stable 32-bit hash of the session id (de-branded from the reference simpleHash) so the
// keep/drop decision is deterministic per session — a reload of the same session resolves
// the same verdict, and rotation to a new id re-rolls the dice.
function hashSessionId(sessionId: string): number {
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) {
    hash = (hash << 5) - hash + sessionId.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

// The per-session keep verdict: true ⇒ record this session, false ⇒ drop it. A rate of 1
// (the default / sampling-off) always keeps; a rate of 0 always drops; anything between is
// the deterministic hash bucket. undefined session id ⇒ no id to sample against yet, so the
// decision stays PENDING (the recorder does not flush while pending — the flush-guard).
export function decideSampled(sessionId: string | undefined, sampleRate: number): boolean | undefined {
  if (sessionId === undefined) {
    return undefined;
  }
  if (sampleRate >= 1) {
    return true;
  }
  if (sampleRate <= 0) {
    return false;
  }
  return hashSessionId(sessionId) % 100 < sampleRate * 100;
}
