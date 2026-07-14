import { describe, expect, test, vi } from 'vitest';
import { computeFlagLocally } from './evaluator';
import type { FlagContext } from '@randomtoni/analytics-kit';
import type { DefinitionSnapshot, FlagDefinition } from './definition-types';
import {
  lowerDefinitions,
  type FeatureFlagDefinition,
} from './neutral-definition';
import { INVALID_DEFINITIONS_MESSAGE, validateDefinitions } from './validate-definitions';

// E20-S1 — the neutral definition type + pure lowering + seed-time validator.
//
// The load-bearing proof: a representative neutral definition set lowered through `lowerDefinitions`
// evaluates IDENTICALLY (same FlagValue, same resolved payload) to the equivalent flags loaded via
// the poller path — the wire fixtures below are the values-known-correct external contract the
// poller's `fetchDefinitions` builds (mirrors `local-parity.test.ts`: `filters.groups` /
// `filters.multivariate.variants` / `filters.payloads`, keyed by stringified `true` / variant-key,
// NEVER a `false` key).

// ---------------------------------------------------------------------------------------------
// The representative neutral set: boolean, multivariate, a condition with property filters + rollout
// + variant override, and payloads.
// ---------------------------------------------------------------------------------------------

const SIMPLE: FeatureFlagDefinition = {
  key: 'simple-flag',
  enabled: true,
  conditions: [{ propertyFilters: [], rolloutPercentage: 100 }],
  payloads: { true: JSON.stringify({ via: 'defn' }) },
};

const MULTIVARIATE: FeatureFlagDefinition = {
  key: 'multivariate-flag',
  enabled: true,
  conditions: [{ propertyFilters: [], rolloutPercentage: 55 }],
  variants: [
    { key: 'first-variant', rolloutPercentage: 50 },
    { key: 'second-variant', rolloutPercentage: 20 },
    { key: 'third-variant', rolloutPercentage: 20 },
    { key: 'fourth-variant', rolloutPercentage: 5 },
    { key: 'fifth-variant', rolloutPercentage: 5 },
  ],
  payloads: { 'second-variant': JSON.stringify({ tier: 'silver' }) },
};

const PROP_GATED: FeatureFlagDefinition = {
  key: 'prop-flag',
  enabled: true,
  conditions: [
    { propertyFilters: [{ property: 'plan', operator: 'exact', value: 'pro' }], rolloutPercentage: 100 },
  ],
};

// A condition with a variantOverride hard-selecting a declared variant.
const OVERRIDE: FeatureFlagDefinition = {
  key: 'override-flag',
  enabled: true,
  conditions: [{ propertyFilters: [], rolloutPercentage: 100, variantOverride: 'third-variant' }],
  variants: [
    { key: 'first-variant', rolloutPercentage: 50 },
    { key: 'second-variant', rolloutPercentage: 25 },
    { key: 'third-variant', rolloutPercentage: 25 },
  ],
};

const DISABLED: FeatureFlagDefinition = {
  key: 'disabled-flag',
  enabled: false,
  conditions: [{ propertyFilters: [], rolloutPercentage: 100 }],
};

const NEUTRAL_SET: FeatureFlagDefinition[] = [SIMPLE, MULTIVARIATE, PROP_GATED, OVERRIDE, DISABLED];

// The equivalent WIRE definitions the poller would fetch — the values-known-correct external contract
// (NOT derived from the lowering). The parity proof asserts the LOWERED snapshot evaluates identically
// to a snapshot built from THESE.
const WIRE_SET: FlagDefinition[] = [
  {
    key: 'simple-flag',
    active: true,
    filters: {
      groups: [{ properties: [], rollout_percentage: 100 }],
      payloads: { true: JSON.stringify({ via: 'defn' }) },
    },
  },
  {
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
      payloads: { 'second-variant': JSON.stringify({ tier: 'silver' }) },
    },
  },
  {
    key: 'prop-flag',
    active: true,
    filters: { groups: [{ properties: [{ key: 'plan', operator: 'exact', value: 'pro' }], rollout_percentage: 100 }] },
  },
  {
    key: 'override-flag',
    active: true,
    filters: {
      groups: [{ properties: [], rollout_percentage: 100, variant: 'third-variant' }],
      multivariate: {
        variants: [
          { key: 'first-variant', rollout_percentage: 50 },
          { key: 'second-variant', rollout_percentage: 25 },
          { key: 'third-variant', rollout_percentage: 25 },
        ],
      },
    },
  },
  {
    key: 'disabled-flag',
    active: false,
    filters: { groups: [{ properties: [], rollout_percentage: 100 }] },
  },
];

// Build the exact snapshot shape the poller's `fetchDefinitions` produces from a fetched flag array.
function pollerSnapshot(flags: FlagDefinition[]): DefinitionSnapshot {
  return {
    flags,
    flagsByKey: flags.reduce<Record<string, FlagDefinition>>((acc, flag) => {
      acc[flag.key] = flag;
      return acc;
    }, {}),
    groupTypeMapping: {},
    cohorts: {},
  };
}

const CONTEXT: FlagContext = { distinctId: 'distinct_id_0', personProperties: { plan: 'pro' } };

// ---------------------------------------------------------------------------------------------
// Lowering shape.
// ---------------------------------------------------------------------------------------------

describe('lowerDefinitions — wire shape', () => {
  test('produces a complete DefinitionSnapshot: flags, flagsByKey (disabled kept), empty groupTypeMapping/cohorts', () => {
    const snap = lowerDefinitions(NEUTRAL_SET);
    expect(snap.flags).toHaveLength(NEUTRAL_SET.length);
    expect(Object.keys(snap.flagsByKey).sort()).toEqual(
      ['disabled-flag', 'multivariate-flag', 'override-flag', 'prop-flag', 'simple-flag'].sort()
    );
    // The disabled flag stays in the snapshot (known-but-off, not unknown).
    expect(snap.flagsByKey['disabled-flag']).toBeDefined();
    expect(snap.flagsByKey['disabled-flag'].active).toBe(false);
    expect(snap.groupTypeMapping).toEqual({});
    expect(snap.cohorts).toEqual({});
  });

  test('never emits wire-only tokens (type / aggregation_group_type_index / ensure_experience_continuity)', () => {
    const snap = lowerDefinitions(NEUTRAL_SET);
    for (const flag of snap.flags) {
      expect(flag).not.toHaveProperty('ensure_experience_continuity');
      expect(flag.filters).not.toHaveProperty('aggregation_group_type_index');
      for (const group of flag.filters?.groups ?? []) {
        for (const prop of group.properties ?? []) {
          expect(prop).not.toHaveProperty('type');
        }
      }
    }
  });

  test('maps neutral vocabulary to wire vocabulary field-for-field', () => {
    const snap = lowerDefinitions([PROP_GATED]);
    const flag = snap.flags[0];
    expect(flag.active).toBe(true); // enabled -> active
    const group = flag.filters?.groups?.[0];
    expect(group?.rollout_percentage).toBe(100); // rolloutPercentage -> rollout_percentage
    const prop = group?.properties?.[0];
    expect(prop?.key).toBe('plan'); // property -> key
    expect(prop?.operator).toBe('exact');
    expect(prop?.value).toBe('pro');
  });

  test('defaults the operator to exact and maps negated -> negation', () => {
    const withNegation: FeatureFlagDefinition = {
      key: 'neg-flag',
      enabled: true,
      conditions: [{ propertyFilters: [{ property: 'country', value: 'US', negated: true }] }],
    };
    const snap = lowerDefinitions([withNegation]);
    const prop = snap.flags[0].filters?.groups?.[0].properties?.[0];
    expect(prop?.operator).toBe('exact');
    expect(prop?.negation).toBe(true);
  });

  test('omits multivariate for a boolean flag, emits it for a multivariate flag', () => {
    const snap = lowerDefinitions([SIMPLE, MULTIVARIATE]);
    expect(snap.flags[0].filters?.multivariate).toBeUndefined();
    expect(snap.flags[1].filters?.multivariate?.variants).toHaveLength(5);
  });

  test('maps variantOverride -> group.variant', () => {
    const snap = lowerDefinitions([OVERRIDE]);
    expect(snap.flags[0].filters?.groups?.[0].variant).toBe('third-variant');
  });
});

// ---------------------------------------------------------------------------------------------
// The parity proof: lowered snapshot evaluates identically to the poller-path snapshot.
// ---------------------------------------------------------------------------------------------

describe('parity — lowered snapshot evaluates identically to the poller-path snapshot', () => {
  test('every flag resolves to the SAME value + payload as the wire-fixture snapshot', () => {
    const lowered = lowerDefinitions(NEUTRAL_SET);
    const viaPoller = pollerSnapshot(WIRE_SET);

    for (const key of Object.keys(lowered.flagsByKey)) {
      const loweredValue = computeFlagLocally(lowered.flagsByKey[key], CONTEXT, lowered);
      const pollerValue = computeFlagLocally(viaPoller.flagsByKey[key], CONTEXT, viaPoller);
      expect(loweredValue).toEqual(pollerValue);
    }
  });

  test('the lowered snapshot resolves the reference-correct ground truth', () => {
    const snap = lowerDefinitions(NEUTRAL_SET);
    expect(computeFlagLocally(snap.flagsByKey['simple-flag'], CONTEXT, snap)).toBe(true);
    expect(computeFlagLocally(snap.flagsByKey['multivariate-flag'], CONTEXT, snap)).toBe('second-variant');
    expect(computeFlagLocally(snap.flagsByKey['prop-flag'], CONTEXT, snap)).toBe(true);
    expect(computeFlagLocally(snap.flagsByKey['override-flag'], CONTEXT, snap)).toBe('third-variant');
    expect(computeFlagLocally(snap.flagsByKey['disabled-flag'], CONTEXT, snap)).toBe(false);
  });

  test('payloads key by the resolved value identically to the wire fixture', () => {
    const lowered = lowerDefinitions(NEUTRAL_SET);
    // The payload map rides the lowered wire definition, keyed by the resolved value (true / variant).
    expect(lowered.flagsByKey['simple-flag'].filters?.payloads).toEqual({
      true: JSON.stringify({ via: 'defn' }),
    });
    expect(lowered.flagsByKey['multivariate-flag'].filters?.payloads).toEqual({
      'second-variant': JSON.stringify({ tier: 'silver' }),
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Seed-time validation — each malformed case rejects loudly; a valid set passes.
// ---------------------------------------------------------------------------------------------

describe('validateDefinitions — rejects the reject-list, passes a valid set', () => {
  test('a valid set passes (no throw)', () => {
    expect(() => validateDefinitions(NEUTRAL_SET)).not.toThrow();
  });

  test('rejects a missing/empty key', () => {
    expect(() => validateDefinitions([{ key: '', enabled: true }])).toThrow(INVALID_DEFINITIONS_MESSAGE);
    expect(() => validateDefinitions([{ key: '   ', enabled: true }])).toThrow(/non-empty string/);
  });

  test('rejects duplicate keys', () => {
    expect(() =>
      validateDefinitions([
        { key: 'dup', enabled: true },
        { key: 'dup', enabled: true },
      ])
    ).toThrow(/duplicate key 'dup'/);
  });

  test('rejects an operator outside the closed union', () => {
    expect(() =>
      validateDefinitions([
        {
          key: 'bad-op',
          enabled: true,
          conditions: [{ propertyFilters: [{ property: 'x', operator: 'startswith' as never, value: 'y' }] }],
        },
      ])
    ).toThrow(/unknown operator 'startswith'/);
  });

  test('rejects a condition rolloutPercentage outside 0..100', () => {
    expect(() =>
      validateDefinitions([{ key: 'over', enabled: true, conditions: [{ rolloutPercentage: 150 }] }])
    ).toThrow(/condition rolloutPercentage 150 is outside 0\.\.100/);
    expect(() =>
      validateDefinitions([{ key: 'under', enabled: true, conditions: [{ rolloutPercentage: -1 }] }])
    ).toThrow(/outside 0\.\.100/);
  });

  test('rejects a variant rolloutPercentage outside 0..100', () => {
    expect(() =>
      validateDefinitions([
        { key: 'v', enabled: true, variants: [{ key: 'a', rolloutPercentage: 200 }] },
      ])
    ).toThrow(/variant 'a' rolloutPercentage 200 is outside 0\.\.100/);
  });

  test('rejects multivariate bands summing > 100 but allows < 100', () => {
    expect(() =>
      validateDefinitions([
        {
          key: 'over-sum',
          enabled: true,
          variants: [
            { key: 'a', rolloutPercentage: 60 },
            { key: 'b', rolloutPercentage: 60 },
          ],
        },
      ])
    ).toThrow(/bands sum to 120 \(> 100\)/);
    // < 100 is legal (the gap ⇒ bare true) — no throw.
    expect(() =>
      validateDefinitions([
        {
          key: 'under-sum',
          enabled: true,
          variants: [
            { key: 'a', rolloutPercentage: 30 },
            { key: 'b', rolloutPercentage: 30 },
          ],
        },
      ])
    ).not.toThrow();
  });

  test('rejects a variantOverride not naming a declared variant', () => {
    expect(() =>
      validateDefinitions([
        {
          key: 'bad-override',
          enabled: true,
          conditions: [{ variantOverride: 'ghost' }],
          variants: [{ key: 'real', rolloutPercentage: 100 }],
        },
      ])
    ).toThrow(/variantOverride 'ghost' names no declared variant/);
  });

  test('rejects present-but-empty variants and an empty variant key', () => {
    expect(() => validateDefinitions([{ key: 'empty-variants', enabled: true, variants: [] }])).toThrow(
      /'variants' is present but empty/
    );
    expect(() =>
      validateDefinitions([{ key: 'empty-key', enabled: true, variants: [{ key: '', rolloutPercentage: 100 }] }])
    ).toThrow(/a variant has an empty 'key'/);
  });

  test('aggregates multiple violations into one error', () => {
    let caught: Error | undefined;
    try {
      validateDefinitions([
        { key: '', enabled: true, conditions: [{ rolloutPercentage: 150 }] },
      ]);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toContain('non-empty string');
    expect(caught?.message).toContain('outside 0..100');
  });
});

// ---------------------------------------------------------------------------------------------
// Dead 'false' payload key — WARN, never reject.
// ---------------------------------------------------------------------------------------------

describe("dead 'false' payload key — warns, never rejects", () => {
  test('a definition with a false payload key passes validation but emits a dev-time warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const withDeadKey: FeatureFlagDefinition = {
        key: 'off-payload',
        enabled: true,
        conditions: [{ propertyFilters: [], rolloutPercentage: 100 }],
        payloads: { true: JSON.stringify({ a: 1 }), false: JSON.stringify({ b: 2 }) },
      };
      // Never rejects.
      expect(() => validateDefinitions([withDeadKey])).not.toThrow();
      // But warns, naming the dead key.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("'false' payload key");
      // The type stays permissive — the false key round-trips into the lowered snapshot untouched.
      const snap = lowerDefinitions([withDeadKey]);
      expect(snap.flagsByKey['off-payload'].filters?.payloads).toHaveProperty('false');
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Bar A — the neutral type + lowering are backend-independent.
// ---------------------------------------------------------------------------------------------

describe('bar A — backend-independent authored definitions', () => {
  test('the same authored definitions produce the same evaluation with no adapter involved', () => {
    const snap = lowerDefinitions(NEUTRAL_SET);
    // No adapter, no network: authoring + lowering + the pure evaluator resolve the set directly.
    const values = Object.keys(snap.flagsByKey).map((key) =>
      computeFlagLocally(snap.flagsByKey[key], CONTEXT, snap)
    );
    expect(values).toContain('second-variant');
    expect(values).toContain('third-variant');
    expect(values).toContain(true);
    expect(values).toContain(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Public-surface contract: the neutral TYPE is a consumer-INPUT export; the lowering/validator are
// internal machinery S2 wires (kept OFF the public barrel so the wire DefinitionSnapshot never
// reaches the consumer's declaration surface — the structural-leak guard).
// ---------------------------------------------------------------------------------------------

describe('public-surface contract', () => {
  test('the neutral type family is exported from the node public barrel; the lowering/validator are not', async () => {
    const barrel = await import('../../index');
    // The functions are internal — NOT on the public barrel (their return type would drag the wire
    // snapshot onto the public surface).
    expect('lowerDefinitions' in barrel).toBe(false);
    expect('validateDefinitions' in barrel).toBe(false);
    // The neutral types are type-only exports (erased at runtime), so they carry no runtime binding —
    // this asserts the barrel does not accidentally ship the wire lowering as a value.
  });
});
