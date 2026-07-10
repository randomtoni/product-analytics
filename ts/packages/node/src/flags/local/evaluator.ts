import type { FlagContext } from 'analytics-kit';
import { bucketHash } from './hash';
import { InconclusiveMatchError, RequiresServerEvaluation } from './errors';
import { matchProperty } from './match-property';
import { matchCohort } from './match-cohort';
import type {
  DefinitionSnapshot,
  FlagCondition,
  FlagDefinition,
  FlagValue,
  FlagVariant,
  PropertyBag,
} from './definition-types';

// The pure, synchronous in-process flag evaluator, ported in behavior from posthog's node
// `matchFeatureFlagProperties` / `isConditionMatch` / `getMatchingVariant` / `variantLookupTable`
// (+ the bucketing-value resolution) — de-branded. No I/O, no timers, no HTTP: a pure function of
// (definition, bucketing value, properties, cohort map). Returns a resolved FlagValue or THROWS one
// of the two inconclusive signals for S2 to catch.
// De-branded from posthog's feature-flags.ts computeFlagValueLocally / matchFeatureFlagProperties /
// isConditionMatch / getMatchingVariant / variantLookupTable / getBucketingValueForFlag.

// The salt appended to the bucketing value when banding variants (with NO separator). Rollout
// bucketing uses no salt.
const VARIANT_SALT = 'variant';

// The story-pinned S1→S2 low-level entrypoint. Match a definition against a KNOWN bucketing value
// and the actor's person/group properties, resolving to a FlagValue or throwing an inconclusive
// signal. This is the pure matching engine — it never resolves the bucketing value itself (that's
// `resolveBucketingValue`), so it's trivially unit-testable against a fixed bucketing value.
export function evaluateFlagLocally(
  definition: FlagDefinition,
  bucketingValue: string,
  personProperties: PropertyBag,
  cohorts: DefinitionSnapshot['cohorts']
): FlagValue {
  // An inactive flag is always false, regardless of continuity. Order matters: checking continuity
  // first would return inconclusive for a disabled-but-continuity flag instead of the correct false.
  if (!definition.active) {
    return false;
  }
  if (definition.ensure_experience_continuity) {
    throw new InconclusiveMatchError('Flag has experience continuity enabled');
  }

  const conditions = definition.filters?.groups ?? [];
  let isInconclusive = false;

  // The reference's `early_exit` short-circuit (a three-valued condition result that returns a
  // deterministic false the moment a group's filters match but rollout excludes) is intentionally
  // NOT ported: every group is evaluated. This is strictly more conservative — in the rare case
  // where an early group is rollout-excluded and a later group is inconclusive, this goes
  // inconclusive (→ S2 remote fallback) where the reference would return false. Never wrong; the
  // reference only sets early_exit on all-locally-evaluable flags, so the combination doesn't arise.
  for (const condition of conditions) {
    try {
      if (isConditionMatch(definition, bucketingValue, condition, personProperties, cohorts)) {
        const variantOverride = condition.variant;
        const variants = definition.filters?.multivariate?.variants ?? [];
        if (variantOverride && variants.some((v) => v.key === variantOverride)) {
          return variantOverride;
        }
        return getMatchingVariant(definition, bucketingValue) ?? true;
      }
    } catch (err) {
      if (err instanceof RequiresServerEvaluation) {
        // Static cohort / server-only data — propagate immediately.
        throw err;
      } else if (err instanceof InconclusiveMatchError) {
        // Remember, but let other OR groups try — an inconclusive group must not poison the rest.
        isInconclusive = true;
      } else {
        throw err;
      }
    }
  }

  if (isInconclusive) {
    throw new InconclusiveMatchError(
      "Can't determine whether the flag is enabled with the given properties"
    );
  }
  // Only false when every condition was false.
  return false;
}

// True iff the actor satisfies a single condition group: all property filters match (AND), then the
// rollout gate admits the bucketing value. Empty properties skip the filter block and fall straight
// to the rollout gate. Throws an inconclusive signal for an undecidable leaf.
function isConditionMatch(
  definition: FlagDefinition,
  bucketingValue: string,
  condition: FlagCondition,
  properties: PropertyBag,
  cohorts: DefinitionSnapshot['cohorts']
): boolean {
  const rolloutPercentage = condition.rollout_percentage;
  const filters = condition.properties ?? [];

  if (filters.length > 0) {
    for (const prop of filters) {
      let matches: boolean;
      if (prop.type === 'cohort') {
        const inCohort = matchCohort(prop, properties, cohorts);
        // A flag-level cohort condition carries a membership operator ('in' | 'not_in'); matchCohort
        // reports raw membership, so 'not_in' inverts it here.
        matches = prop.operator === 'not_in' ? !inCohort : inCohort;
      } else if (prop.type === 'flag') {
        // Flag-dependency chains are deferred (S2/remote handles them): inconclusive locally.
        throw new InconclusiveMatchError(`Flag dependency '${prop.key}' cannot be evaluated locally`);
      } else {
        matches = matchProperty(prop, properties);
      }
      if (!matches) {
        return false;
      }
    }
    if (rolloutPercentage === undefined) {
      return true;
    }
  }

  // Property filters (if any) matched; apply the rollout gate. Inclusion is `hash <= rollout/100`;
  // divide by 100.0 (float). 0% admits effectively no one; 100% admits everyone incl. the 1.0 edge.
  if (rolloutPercentage !== undefined && bucketHash(definition.key, bucketingValue) > rolloutPercentage / 100.0) {
    return false;
  }
  return true;
}

// The variant, if any, the bucketing value lands in. Uses the 'variant' salt (an independent hash
// from the rollout gate). Bands are contiguous half-open `[valueMin, valueMax)`, first match wins;
// a hash in a gap (variant percentages sum < 100) returns undefined and the flag resolves to bare
// true.
function getMatchingVariant(definition: FlagDefinition, bucketingValue: string): string | undefined {
  const hashValue = bucketHash(definition.key, bucketingValue, VARIANT_SALT);
  const band = variantLookupTable(definition).find(
    (v) => hashValue >= v.valueMin && hashValue < v.valueMax
  );
  return band?.key;
}

// Build the contiguous variant bands: cumulative running sums of `rollout_percentage / 100` in
// DECLARED array order (never sorted).
function variantLookupTable(
  definition: FlagDefinition
): { valueMin: number; valueMax: number; key: string }[] {
  const table: { valueMin: number; valueMax: number; key: string }[] = [];
  let valueMin = 0;
  const variants: FlagVariant[] = definition.filters?.multivariate?.variants ?? [];
  for (const variant of variants) {
    const valueMax = valueMin + variant.rollout_percentage / 100.0;
    table.push({ valueMin, valueMax, key: variant.key });
    valueMin = valueMax;
  }
  return table;
}

// Resolve the bucketing value for a flag from the neutral FlagContext + the group-type mapping. A
// group-aggregated flag buckets by the group key (from `context.groups[groupName]`); a person flag
// buckets by `distinctId`. Returns undefined when a group-aggregated flag's group isn't supplied
// (the reference returns bare false in that case); the caller decides the terminal value. Throws
// InconclusiveMatchError when the flag's group-type index isn't in the mapping.
// De-branded from posthog's feature-flags.ts computeFlagValueLocally group branch +
// getBucketingValueForFlag.
export function resolveBucketingValue(
  definition: FlagDefinition,
  context: FlagContext,
  groupTypeMapping: DefinitionSnapshot['groupTypeMapping']
): { bucketingValue: string; properties: PropertyBag } | 'group-not-supplied' {
  const aggregationIndex = definition.filters?.aggregation_group_type_index;
  if (aggregationIndex !== undefined) {
    const groupName = groupTypeMapping[String(aggregationIndex)];
    if (!groupName) {
      throw new InconclusiveMatchError(
        `Flag '${definition.key}' references an unknown group type index`
      );
    }
    const groups = context.groups ?? {};
    if (!(groupName in groups)) {
      // The group this flag is aggregated by wasn't supplied — the reference resolves to false.
      return 'group-not-supplied';
    }
    const groupProperties = context.groupProperties?.[groupName] ?? {};
    return { bucketingValue: groups[groupName], properties: groupProperties };
  }

  const distinctId = context.distinctId;
  if (distinctId === undefined || distinctId === '') {
    throw new InconclusiveMatchError(
      `Flag '${definition.key}' cannot be evaluated locally without a distinctId`
    );
  }
  return { bucketingValue: distinctId, properties: context.personProperties ?? {} };
}

// The higher-level S1→S2 entrypoint S2 binds to: resolve the bucketing value from the neutral
// FlagContext + the poller's snapshot, then run the pure matcher. Returns a FlagValue or throws an
// inconclusive signal. S2 passes its FlagContext + the snapshot and never touches the definition's
// group-aggregation internals.
export function computeFlagLocally(
  definition: FlagDefinition,
  context: FlagContext,
  snapshot: DefinitionSnapshot
): FlagValue {
  if (!definition.active) {
    return false;
  }
  const resolved = resolveBucketingValue(definition, context, snapshot.groupTypeMapping);
  if (resolved === 'group-not-supplied') {
    return false;
  }
  return evaluateFlagLocally(definition, resolved.bucketingValue, resolved.properties, snapshot.cohorts);
}
