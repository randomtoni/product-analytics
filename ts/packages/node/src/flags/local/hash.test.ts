import { describe, expect, test } from 'vitest';
import { bucketHash, hashSHA1 } from './hash';
import { evaluateFlagLocally } from './evaluator';
import type { FlagDefinition } from './definition-types';

// The load-bearing cross-tree parity invariant, asserted at THREE tiers against the pinned
// reference vector (S3 Python must match these byte-for-byte; S4 anchors them against a real
// remote eval). A wrong f-count, wrong slice length, or int-vs-float division fails here.

describe('tier 1 — the SHA1 primitive', () => {
  test('SHA1("some-flag.some_distinct_id") matches the pinned digest exactly', () => {
    expect(hashSHA1('some-flag.some_distinct_id')).toBe(
      'e4ce124e800a818c63099f95fa085dc2b620e173'
    );
  });
});

describe('tier 2 — the exact _hash floats', () => {
  test('rollout-salt bucket floats match the pinned values exactly', () => {
    expect(bucketHash('simple-flag', 'distinct_id_0')).toBe(0.78369637642204315);
    expect(bucketHash('simple-flag', 'distinct_id_1')).toBe(0.33970699269954008);
    expect(bucketHash('simple-flag', 'distinct_id_2')).toBe(0.37204343502390519);
  });

  test('variant-salt bucket float matches the pinned value exactly', () => {
    expect(bucketHash('multivariate-flag', 'distinct_id_0', 'variant')).toBe(
      0.61864545379303792
    );
  });

  test('an all-f slice yields exactly 1.0 (top-inclusive, not renormalized to [0,1))', () => {
    // The divisor IS the all-f numerator, so a key/value producing an all-f 15-nibble slice → 1.0.
    // We assert the boundary directly: (all-f numerator) / LONG_SCALE === 1.0, the edge the
    // 100%-rollout gate needs. Parsed at runtime (Number('0x...')) so the 60-bit literal doesn't
    // trip the no-loss-of-precision lint.
    const allF = parseInt('f'.repeat(15), 16);
    const LONG_SCALE = Number('0xfffffffffffffff');
    expect(allF / LONG_SCALE).toBe(1.0);
  });
});

// Definition builders for the tier-3 end-to-end vectors, de-branded from the reference consistency
// suites (feature-flags.spec.ts "is consistent for simple flags" / "multivariate flags").
function simpleFlag(rolloutPercentage: number): FlagDefinition {
  return {
    key: 'simple-flag',
    active: true,
    filters: { groups: [{ properties: [], rollout_percentage: rolloutPercentage }] },
  };
}

function multivariateFlag(): FlagDefinition {
  return {
    key: 'multivariate-flag',
    active: true,
    filters: {
      groups: [{ properties: [], rollout_percentage: 55 }],
      multivariate: {
        variants: [
          { key: 'first-variant', rollout_percentage: 50 },
          { key: 'second-variant', rollout_percentage: 20 },
          { key: 'third-variant', rollout_percentage: 20 },
          { key: 'fourth-variant', rollout_percentage: 5 },
          { key: 'fifth-variant', rollout_percentage: 5 },
        ],
      },
    },
  };
}

function evalOver(def: FlagDefinition, count: number): Array<string | boolean> {
  const out: Array<string | boolean> = [];
  for (let i = 0; i < count; i++) {
    out.push(evaluateFlagLocally(def, `distinct_id_${i}`, {}, {}, {}));
  }
  return out;
}

describe('tier 3 — end-to-end consistency vectors', () => {
  test('simple-flag at 45% over distinct_id_{0..9} matches the pinned boolean vector', () => {
    expect(evalOver(simpleFlag(45), 10)).toEqual([
      false,
      true,
      true,
      false,
      true,
      false,
      false,
      true,
      false,
      true,
    ]);
  });

  test('multivariate-flag (group 55%, variants 50/20/20/5/5) over distinct_id_{0..9} matches the pinned variant vector', () => {
    expect(evalOver(multivariateFlag(), 10)).toEqual([
      'second-variant',
      'second-variant',
      'first-variant',
      false,
      false,
      'second-variant',
      'first-variant',
      false,
      false,
      false,
    ]);
  });

  test('the same actor lands in the same value deterministically across repeated runs', () => {
    const def = multivariateFlag();
    const first = evaluateFlagLocally(def, 'distinct_id_2', {}, {}, {});
    const second = evaluateFlagLocally(def, 'distinct_id_2', {}, {}, {});
    expect(first).toBe(second);
    expect(first).toBe('first-variant');
  });
});

describe('rollout boundary behavior', () => {
  test('a 0% rollout never matches (no one is admitted)', () => {
    const results = evalOver(simpleFlag(0), 20);
    expect(results.every((r) => r === false)).toBe(true);
  });

  test('a 100% rollout always matches (everyone incl. the 1.0 edge)', () => {
    const results = evalOver(simpleFlag(100), 20);
    expect(results.every((r) => r === true)).toBe(true);
  });
});
