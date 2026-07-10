import { describe, expect, test } from 'vitest';
import {
  computeFlagLocally,
  evaluateFlagLocally,
  resolveBucketingValue,
} from './evaluator';
import { InconclusiveMatchError, RequiresServerEvaluation } from './errors';
import type {
  DefinitionSnapshot,
  FlagDefinition,
  PropertyGroup,
} from './definition-types';

function snapshot(over: Partial<DefinitionSnapshot> = {}): DefinitionSnapshot {
  return {
    flags: over.flags ?? [],
    flagsByKey: over.flagsByKey ?? {},
    groupTypeMapping: over.groupTypeMapping ?? {},
    cohorts: over.cohorts ?? {},
  };
}

describe('active / continuity', () => {
  test('an inactive flag is always false, regardless of conditions', () => {
    const def: FlagDefinition = {
      key: 'f',
      active: false,
      filters: { groups: [{ properties: [], rollout_percentage: 100 }] },
    };
    expect(evaluateFlagLocally(def, 'u1', {}, {})).toBe(false);
  });

  test('experience continuity throws inconclusive', () => {
    const def: FlagDefinition = {
      key: 'f',
      active: true,
      ensure_experience_continuity: true,
      filters: { groups: [{ properties: [], rollout_percentage: 100 }] },
    };
    expect(() => evaluateFlagLocally(def, 'u1', {}, {})).toThrow(InconclusiveMatchError);
  });
});

describe('condition groups — OR across groups, AND within a group', () => {
  test('a group matches when all its property filters match and rollout admits', () => {
    const def: FlagDefinition = {
      key: 'f',
      active: true,
      filters: {
        groups: [
          {
            properties: [
              { key: 'plan', value: 'pro', operator: 'exact' },
              { key: 'country', value: 'US', operator: 'exact' },
            ],
            rollout_percentage: 100,
          },
        ],
      },
    };
    expect(evaluateFlagLocally(def, 'u1', { plan: 'pro', country: 'us' }, {})).toBe(true);
    // One filter fails ⇒ AND fails ⇒ no match ⇒ false.
    expect(evaluateFlagLocally(def, 'u1', { plan: 'pro', country: 'gb' }, {})).toBe(false);
  });

  test('a later OR group can match when an earlier one does not', () => {
    const def: FlagDefinition = {
      key: 'f',
      active: true,
      filters: {
        groups: [
          { properties: [{ key: 'plan', value: 'enterprise', operator: 'exact' }], rollout_percentage: 100 },
          { properties: [{ key: 'plan', value: 'pro', operator: 'exact' }], rollout_percentage: 100 },
        ],
      },
    };
    expect(evaluateFlagLocally(def, 'u1', { plan: 'pro' }, {})).toBe(true);
  });

  test('a group with empty properties falls straight to the rollout gate', () => {
    const def: FlagDefinition = {
      key: 'f',
      active: true,
      filters: { groups: [{ properties: [], rollout_percentage: 100 }] },
    };
    expect(evaluateFlagLocally(def, 'u1', {}, {})).toBe(true);
  });

  test('an inconclusive earlier group does not poison a later matching group', () => {
    const def: FlagDefinition = {
      key: 'f',
      active: true,
      filters: {
        groups: [
          // Missing property ⇒ inconclusive.
          { properties: [{ key: 'missing', value: 'x', operator: 'exact' }], rollout_percentage: 100 },
          // This group matches.
          { properties: [{ key: 'plan', value: 'pro', operator: 'exact' }], rollout_percentage: 100 },
        ],
      },
    };
    expect(evaluateFlagLocally(def, 'u1', { plan: 'pro' }, {})).toBe(true);
  });

  test('inconclusive in the ONLY group throws inconclusive out of the evaluator', () => {
    const def: FlagDefinition = {
      key: 'f',
      active: true,
      filters: {
        groups: [{ properties: [{ key: 'missing', value: 'x', operator: 'exact' }], rollout_percentage: 100 }],
      },
    };
    expect(() => evaluateFlagLocally(def, 'u1', {}, {})).toThrow(InconclusiveMatchError);
  });
});

describe('variant bands (contiguous, half-open, declared order, first-match)', () => {
  test('a matched flag with variants resolves to the banded variant, deterministic per actor', () => {
    const def: FlagDefinition = {
      key: 'multivariate-flag',
      active: true,
      filters: {
        groups: [{ properties: [], rollout_percentage: 100 }],
        multivariate: {
          variants: [
            { key: 'first-variant', rollout_percentage: 50 },
            { key: 'second-variant', rollout_percentage: 50 },
          ],
        },
      },
    };
    const v = evaluateFlagLocally(def, 'distinct_id_0', {}, {});
    expect(typeof v).toBe('string');
    expect(['first-variant', 'second-variant']).toContain(v);
    // Deterministic.
    expect(evaluateFlagLocally(def, 'distinct_id_0', {}, {})).toBe(v);
  });

  test('a hash landing in a gap (variant percentages sum < 100) resolves to bare true', () => {
    // With a single 1% variant band, almost every actor lands in the gap → bare true.
    const def: FlagDefinition = {
      key: 'gappy-flag',
      active: true,
      filters: {
        groups: [{ properties: [], rollout_percentage: 100 }],
        multivariate: { variants: [{ key: 'only', rollout_percentage: 1 }] },
      },
    };
    // distinct_id_0's variant-salt hash is ~0.62 → outside the [0, 0.01) band → bare true.
    expect(evaluateFlagLocally(def, 'distinct_id_0', {}, {})).toBe(true);
  });

  test('a hard condition.variant override wins over the banded variant', () => {
    const def: FlagDefinition = {
      key: 'f',
      active: true,
      filters: {
        groups: [{ properties: [], rollout_percentage: 100, variant: 'second-variant' }],
        multivariate: {
          variants: [
            { key: 'first-variant', rollout_percentage: 50 },
            { key: 'second-variant', rollout_percentage: 50 },
          ],
        },
      },
    };
    expect(evaluateFlagLocally(def, 'distinct_id_0', {}, {})).toBe('second-variant');
  });

  test('a condition.variant that is not a declared variant is ignored (falls to banding)', () => {
    const def: FlagDefinition = {
      key: 'f',
      active: true,
      filters: {
        groups: [{ properties: [], rollout_percentage: 100, variant: 'nonexistent' }],
        multivariate: { variants: [{ key: 'only', rollout_percentage: 100 }] },
      },
    };
    expect(evaluateFlagLocally(def, 'distinct_id_0', {}, {})).toBe('only');
  });
});

describe('cohort matching (nested AND/OR against the cohort map)', () => {
  const proCohort: PropertyGroup = {
    type: 'AND',
    values: [{ key: 'plan', value: 'pro', operator: 'exact', type: 'person' }],
  };

  test('a cohort condition matches when the actor is in the cohort', () => {
    const def: FlagDefinition = {
      key: 'f',
      active: true,
      filters: { groups: [{ properties: [{ key: 'id', value: 'c1', type: 'cohort' }], rollout_percentage: 100 }] },
    };
    const snap = snapshot({ cohorts: { c1: proCohort } });
    expect(computeFlagLocally(def, { distinctId: 'u1', personProperties: { plan: 'pro' } }, snap)).toBe(true);
    expect(computeFlagLocally(def, { distinctId: 'u1', personProperties: { plan: 'free' } }, snap)).toBe(false);
  });

  test("a not_in cohort operator inverts membership", () => {
    const def: FlagDefinition = {
      key: 'f',
      active: true,
      filters: {
        groups: [{ properties: [{ key: 'id', value: 'c1', type: 'cohort', operator: 'not_in' }], rollout_percentage: 100 }],
      },
    };
    const snap = snapshot({ cohorts: { c1: proCohort } });
    // Not in the pro cohort ⇒ not_in matches ⇒ true.
    expect(computeFlagLocally(def, { distinctId: 'u1', personProperties: { plan: 'free' } }, snap)).toBe(true);
    expect(computeFlagLocally(def, { distinctId: 'u1', personProperties: { plan: 'pro' } }, snap)).toBe(false);
  });

  test('a nested OR cohort matches on either branch', () => {
    const orCohort: PropertyGroup = {
      type: 'OR',
      values: [
        { key: 'plan', value: 'pro', operator: 'exact', type: 'person' },
        { key: 'plan', value: 'enterprise', operator: 'exact', type: 'person' },
      ],
    };
    const def: FlagDefinition = {
      key: 'f',
      active: true,
      filters: { groups: [{ properties: [{ key: 'id', value: 'c1', type: 'cohort' }], rollout_percentage: 100 }] },
    };
    const snap = snapshot({ cohorts: { c1: orCohort } });
    expect(computeFlagLocally(def, { distinctId: 'u1', personProperties: { plan: 'enterprise' } }, snap)).toBe(true);
    expect(computeFlagLocally(def, { distinctId: 'u1', personProperties: { plan: 'basic' } }, snap)).toBe(false);
  });

  test('a cohort absent from the local map throws RequiresServerEvaluation (static cohort)', () => {
    const def: FlagDefinition = {
      key: 'f',
      active: true,
      filters: { groups: [{ properties: [{ key: 'id', value: 'static-1', type: 'cohort' }], rollout_percentage: 100 }] },
    };
    const snap = snapshot({ cohorts: {} });
    expect(() => computeFlagLocally(def, { distinctId: 'u1' }, snap)).toThrow(RequiresServerEvaluation);
  });
});

describe('the two inconclusive signals are distinct and both propagate out', () => {
  test('RequiresServerEvaluation is distinguishable from InconclusiveMatchError', () => {
    const staticCohortFlag: FlagDefinition = {
      key: 'f',
      active: true,
      filters: { groups: [{ properties: [{ key: 'id', value: 'static-1', type: 'cohort' }], rollout_percentage: 100 }] },
    };
    const missingPropFlag: FlagDefinition = {
      key: 'g',
      active: true,
      filters: { groups: [{ properties: [{ key: 'missing', value: 'x', operator: 'exact' }], rollout_percentage: 100 }] },
    };
    const snap = snapshot({ cohorts: {} });

    let staticErr: unknown;
    try {
      computeFlagLocally(staticCohortFlag, { distinctId: 'u1' }, snap);
    } catch (e) {
      staticErr = e;
    }
    let missingErr: unknown;
    try {
      computeFlagLocally(missingPropFlag, { distinctId: 'u1' }, snap);
    } catch (e) {
      missingErr = e;
    }

    expect(staticErr).toBeInstanceOf(RequiresServerEvaluation);
    expect(staticErr).not.toBeInstanceOf(InconclusiveMatchError);
    expect(missingErr).toBeInstanceOf(InconclusiveMatchError);
    expect(missingErr).not.toBeInstanceOf(RequiresServerEvaluation);
  });

  test('the neutral error names/messages carry no vendor token', () => {
    for (const err of [new InconclusiveMatchError('cannot decide'), new RequiresServerEvaluation('static cohort')]) {
      expect(err.name.toLowerCase()).not.toContain('posthog');
      expect(err.message.toLowerCase()).not.toContain('posthog');
    }
  });

  test('a flag-typed property (flag dependency) is inconclusive locally', () => {
    const def: FlagDefinition = {
      key: 'f',
      active: true,
      filters: { groups: [{ properties: [{ key: 'other-flag', value: true, type: 'flag' }], rollout_percentage: 100 }] },
    };
    expect(() => evaluateFlagLocally(def, 'u1', {}, {})).toThrow(InconclusiveMatchError);
  });
});

describe('group-aggregation bucketing via resolveBucketingValue / computeFlagLocally', () => {
  test('a group-aggregated flag buckets by the group key and uses the focused group properties', () => {
    const def: FlagDefinition = {
      key: 'f',
      active: true,
      filters: {
        aggregation_group_type_index: 0,
        groups: [{ properties: [{ key: 'tier', value: 'gold', operator: 'exact' }], rollout_percentage: 100 }],
      },
    };
    const snap = snapshot({ groupTypeMapping: { '0': 'org' } });
    const resolved = resolveBucketingValue(def, { distinctId: 'u1', groups: { org: 'acme' }, groupProperties: { org: { tier: 'gold' } } }, snap.groupTypeMapping);
    expect(resolved).toEqual({ bucketingValue: 'acme', properties: { tier: 'gold' } });
    expect(computeFlagLocally(def, { distinctId: 'u1', groups: { org: 'acme' }, groupProperties: { org: { tier: 'gold' } } }, snap)).toBe(true);
  });

  test('a group-aggregated flag with the group NOT supplied resolves to false', () => {
    const def: FlagDefinition = {
      key: 'f',
      active: true,
      filters: { aggregation_group_type_index: 0, groups: [{ properties: [], rollout_percentage: 100 }] },
    };
    const snap = snapshot({ groupTypeMapping: { '0': 'org' } });
    expect(computeFlagLocally(def, { distinctId: 'u1' }, snap)).toBe(false);
  });

  test('an unknown group-type index throws inconclusive', () => {
    const def: FlagDefinition = {
      key: 'f',
      active: true,
      filters: { aggregation_group_type_index: 9, groups: [{ properties: [], rollout_percentage: 100 }] },
    };
    const snap = snapshot({ groupTypeMapping: { '0': 'org' } });
    expect(() => computeFlagLocally(def, { distinctId: 'u1', groups: { org: 'acme' } }, snap)).toThrow(InconclusiveMatchError);
  });

  test('a person flag with no distinctId throws inconclusive at bucketing resolution', () => {
    const def: FlagDefinition = {
      key: 'f',
      active: true,
      filters: { groups: [{ properties: [], rollout_percentage: 100 }] },
    };
    const snap = snapshot();
    expect(() => resolveBucketingValue(def, {}, snap.groupTypeMapping)).toThrow(InconclusiveMatchError);
  });

  test('a group-aggregated flag filters on the focused group properties with no separate group-props arg', () => {
    // Group properties reach the matcher via resolveBucketingValue → the single `properties` bag, so
    // computeFlagLocally decides a group-property filter WITHOUT the evaluator ever taking a
    // group-properties parameter (parity with the Python evaluate_flag_locally, which has none).
    const def: FlagDefinition = {
      key: 'f',
      active: true,
      filters: {
        aggregation_group_type_index: 0,
        groups: [{ properties: [{ key: 'tier', value: 'gold', operator: 'exact' }], rollout_percentage: 100 }],
      },
    };
    const snap = snapshot({ groupTypeMapping: { '0': 'org' } });
    expect(
      computeFlagLocally(def, { distinctId: 'u1', groups: { org: 'acme' }, groupProperties: { org: { tier: 'gold' } } }, snap)
    ).toBe(true);
    // A non-matching group property fails the AND ⇒ false (the group-props filter is honored).
    expect(
      computeFlagLocally(def, { distinctId: 'u1', groups: { org: 'acme' }, groupProperties: { org: { tier: 'silver' } } }, snap)
    ).toBe(false);
  });
});

describe('evaluator surface arity (F3 parity)', () => {
  test('evaluateFlagLocally takes exactly (definition, bucketingValue, personProperties, cohorts)', () => {
    // Pins the de-branded evaluator to 4 params — the dead group-properties parameter is gone, so the
    // exported surface matches the Python twin. A reintroduced 5th param would fail typecheck at every
    // call site; this length assertion is the runtime backstop.
    expect(evaluateFlagLocally.length).toBe(4);
  });

  test('person properties still drive property filters through arg 3', () => {
    const def: FlagDefinition = {
      key: 'f',
      active: true,
      filters: { groups: [{ properties: [{ key: 'plan', value: 'pro', operator: 'exact' }], rollout_percentage: 100 }] },
    };
    expect(evaluateFlagLocally(def, 'u1', { plan: 'pro' }, {})).toBe(true);
    expect(evaluateFlagLocally(def, 'u1', { plan: 'free' }, {})).toBe(false);
  });
});
