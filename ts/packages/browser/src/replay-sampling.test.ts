import { afterEach, describe, expect, test, vi } from 'vitest';
import { decideSampled, normalizeSampleRate } from './replay-sampling';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('normalizeSampleRate — normalize-to-default, never throw (E14-S4)', () => {
  test('a finite rate in [0,1] is used as-is', () => {
    expect(normalizeSampleRate(0)).toBe(0);
    expect(normalizeSampleRate(0.25)).toBe(0.25);
    expect(normalizeSampleRate(1)).toBe(1);
  });

  test('an absent rate falls back to the default (record all)', () => {
    expect(normalizeSampleRate(undefined)).toBe(1);
  });

  test('an out-of-range rate above 1 normalizes to DEFAULT (record all) — NOT clamped to 1', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Clamping 1.1→1 would silently record 100% of a session the consumer meant to sample
    // DOWN — the expensive surprise. Normalize-to-default records all AND warns, so the
    // misconfig is visible rather than masquerading as a valid full-capture setting.
    expect(normalizeSampleRate(1.1)).toBe(1);
    expect(warn).toHaveBeenCalledOnce();
  });

  test('a negative rate normalizes to the default with a dev warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(normalizeSampleRate(-3)).toBe(1);
    expect(warn).toHaveBeenCalledOnce();
  });

  test('NaN / Infinity / a non-number normalize to the default with a warning, never throw', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(normalizeSampleRate(NaN)).toBe(1);
    expect(normalizeSampleRate(Infinity)).toBe(1);
    // A non-number sneaking past the type at a JS boundary degrades rather than throwing.
    expect(normalizeSampleRate('0.5' as unknown as number)).toBe(1);
    expect(warn).toHaveBeenCalledTimes(3);
  });
});

describe('decideSampled — deterministic per-session keep/drop (E14-S4)', () => {
  test('an undefined session id leaves the decision PENDING (undefined) — the flush-guard', () => {
    // No id yet ⇒ no id to sample against ⇒ the recorder must not flush (pending is not keep).
    expect(decideSampled(undefined, 0.5)).toBeUndefined();
  });

  test('a rate of 1 (default / sampling off) always keeps', () => {
    expect(decideSampled('any-session', 1)).toBe(true);
  });

  test('a rate of 0 always drops (sampled out)', () => {
    expect(decideSampled('any-session', 0)).toBe(false);
  });

  test('the decision is deterministic per session id — same id + rate ⇒ same verdict', () => {
    const first = decideSampled('session-abc', 0.5);
    const second = decideSampled('session-abc', 0.5);
    expect(first).toBe(second);
    expect(typeof first).toBe('boolean');
  });

  test('different session ids can resolve to different verdicts under a partial rate', () => {
    // Find two ids that disagree, proving the hash actually partitions sessions (not a
    // constant). A deterministic hash over varied inputs must produce both keeps and drops.
    const verdicts = new Set<boolean>();
    for (let i = 0; i < 200; i++) {
      verdicts.add(decideSampled(`session-${i}`, 0.5) as boolean);
    }
    expect(verdicts.has(true)).toBe(true);
    expect(verdicts.has(false)).toBe(true);
  });
});
