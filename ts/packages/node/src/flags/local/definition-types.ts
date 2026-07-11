import type { FlagValue } from '@randomtoni/analytics-kit';

// The adapter-internal [WIRE] flag-DEFINITION vocabulary: the shape the definitions endpoint
// speaks, which the poller fetches and the evaluator matches against. None of it appears on the
// neutral surface — S2 reads a resolved FlagSet, never these types. A future backend adapter
// negotiating a different definition wire supplies its own. De-branded from posthog's node
// PostHogFeatureFlag / FeatureFlagCondition / FlagProperty / PropertyGroup (types.ts) and the
// FlagDefinitionCacheData snapshot (feature-flags.ts updateFlagState).

// A property comparison value: a scalar, an array (membership), or a boolean.
export type FlagPropertyValue = string | number | boolean | (string | number)[];

// One property filter inside a condition group or a cohort property-group. `type` distinguishes a
// plain person/group property from a cohort reference (and a flag dependency, deferred here — a
// `flag`-typed property is treated as inconclusive). `operator` defaults to 'exact'.
export interface FlagProperty {
  key: string;
  type?: string;
  value: FlagPropertyValue;
  operator?: string;
  negation?: boolean;
}

// A cohort's nested boolean tree: AND/OR over either nested groups or leaf property filters.
export interface PropertyGroup {
  type: 'AND' | 'OR';
  values: PropertyGroup[] | FlagProperty[];
}

// One targeting condition group. Properties AND together; the rollout gate applies after they
// match. `variant` is a hard override selecting a specific variant when the group matches.
// `aggregation_group_type_index` on a condition is the mixed-targeting override (deferred here —
// the flag-level aggregation index is what the bucketing resolver reads).
export interface FlagCondition {
  properties?: FlagProperty[];
  rollout_percentage?: number;
  variant?: string;
  aggregation_group_type_index?: number | null;
}

// One multivariate variant and the share of matched traffic it claims. Bands are cumulative in
// DECLARED array order (never sorted).
export interface FlagVariant {
  key: string;
  rollout_percentage: number;
}

// A single flag definition. `filters.groups` are the OR-ed condition groups; `multivariate`
// carries the variant bands; `payloads` maps a resolved value (variant key, or 'true'/'false')
// to its payload. `aggregation_group_type_index` marks a group-aggregated flag (bucketed by the
// group key, not distinctId). De-branded from posthog's PostHogFeatureFlag.
export interface FlagDefinition {
  key: string;
  active: boolean;
  ensure_experience_continuity?: boolean;
  filters?: {
    aggregation_group_type_index?: number;
    groups?: FlagCondition[];
    multivariate?: {
      variants: FlagVariant[];
    };
    payloads?: Record<string, unknown>;
  };
}

// The parsed, in-memory definition snapshot the poller holds and the evaluator reads. Replaced
// atomically on each successful poll so an evaluation pass reads one consistent generation.
// `flagsByKey` is the O(1) lookup built alongside `flags`; `groupTypeMapping` resolves a flag's
// aggregation index to a group name; `cohorts` is the locally-fetched cohort map.
// De-branded from posthog's FlagDefinitionCacheData (+ the by-key index from updateFlagState).
export interface DefinitionSnapshot {
  flags: readonly FlagDefinition[];
  flagsByKey: Readonly<Record<string, FlagDefinition>>;
  groupTypeMapping: Readonly<Record<string, string>>;
  cohorts: Readonly<Record<string, PropertyGroup>>;
}

// The property bag an actor is described by (person or a focused group's properties).
export type PropertyBag = Record<string, unknown>;

// A locally-resolved flag value: the story-pinned FlagValue (string variant | boolean). Re-exported
// under a local alias so the evaluator's internal signatures don't depend on the neutral import
// path directly.
export type { FlagValue };
