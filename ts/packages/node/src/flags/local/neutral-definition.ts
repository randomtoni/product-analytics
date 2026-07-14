import type {
  DefinitionSnapshot,
  FlagCondition as WireFlagCondition,
  FlagDefinition as WireFlagDefinition,
  FlagProperty as WireFlagProperty,
  FlagVariant as WireFlagVariant,
} from './definition-types';

// The NEUTRAL, consumer-facing flag-DEFINITION contract — the shape a consumer authors static flag
// definitions in, purpose-designed in neutral vocabulary rather than the adapter-internal wire shape
// (`filters.groups` / `multivariate.variants` / `ensure_experience_continuity` / index-based
// aggregation). This type is the stable, versioned additive contract; the wire `DefinitionSnapshot`
// churns behind `lowerDefinitions`, which is the ONLY thing that knows both shapes. A future backend
// adapter negotiating a different definition wire writes its own lowering from this SAME neutral type
// (acceptance-bar-1 applied to definitions). Distinct from the frozen `FeatureFlagPort` / `FlagSet` /
// `FlagContext` EVAL surface — this is the consumer-INPUT surface.

// A property-comparison value: a scalar, a boolean, or an array (membership). Mirrors the operator
// engine's string-folding value model.
export type FlagFilterValue = string | number | boolean | (string | number)[];

// The CLOSED set of property-comparison operators the local operator engine (`matchProperty`)
// handles — the one place the neutral type diverges from the wire's open `operator?: string`. A
// closed union IS the consumer contract and what the validator checks. ADDITIVE-ONLY: adding an
// operator is non-breaking, renaming/removing one is breaking. These are exactly the 23 tokens the
// engine switches on (cohort-membership `in`/`not_in` and flag-dependency `flag` are handled
// elsewhere and are scoped OUT of neutral v1, so they correctly do not appear here).
export type FlagFilterOperator =
  | 'exact'
  | 'is_not'
  | 'is_set'
  | 'is_not_set'
  | 'icontains'
  | 'not_icontains'
  | 'regex'
  | 'not_regex'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'is_date_before'
  | 'is_date_after'
  | 'semver_eq'
  | 'semver_neq'
  | 'semver_gt'
  | 'semver_gte'
  | 'semver_lt'
  | 'semver_lte'
  | 'semver_tilde'
  | 'semver_caret'
  | 'semver_wildcard';

// One property filter inside a condition. The actor's `property` value is compared against `value`
// under `operator` (default `'exact'`); `negated` inverts the leaf match. Names the concept, not the
// wire token (`property` = wire `key`, `negated` = wire `negation`).
export interface PropertyFilter {
  property: string;
  operator?: FlagFilterOperator;
  value: FlagFilterValue;
  negated?: boolean;
}

// One targeting condition. `propertyFilters` AND together; the `rolloutPercentage` gate applies after
// they match (omitted ⇒ admit every matched actor). `variantOverride` hard-selects a declared variant
// when the condition matches. Conditions across a definition OR together.
export interface FlagCondition {
  propertyFilters?: PropertyFilter[];
  rolloutPercentage?: number;
  variantOverride?: string;
}

// One multivariate variant and the share of matched traffic it claims. Bands are cumulative in
// DECLARED array order.
export interface FlagVariant {
  key: string;
  rolloutPercentage: number;
}

// A single neutral flag definition. `enabled: false` always resolves to false. `conditions`
// omitted/empty ⇒ nothing matches ⇒ false. `variants` present ⇒ multivariate, absent ⇒ boolean.
// `payloads` is keyed by the RESOLVED value (a variant key, or `'true'`); a `'false'` key is
// unreachable under local eval (the resolver returns early on a false-resolved flag before any
// payload lookup) but the type stays permissive — reachability is an adapter-internal mechanic, not
// a neutral-contract invariant, so a future adapter that resolves off-state payloads differently is
// not blocked by the type.
export interface FeatureFlagDefinition {
  key: string;
  enabled: boolean;
  conditions?: FlagCondition[];
  variants?: FlagVariant[];
  payloads?: Record<string, unknown>;
}

// The default property-comparison operator when a filter omits `operator` — matches the engine's
// `property.operator || 'exact'`.
const DEFAULT_OPERATOR: FlagFilterOperator = 'exact';

// Lower a neutral definition set to the COMPLETE wire `DefinitionSnapshot` the evaluator reads — the
// exact shape the poller's `fetchDefinitions` builds, so a seeded snapshot (S2) is read identically
// by the UNCHANGED adapter: `flags` = the lowered array, `flagsByKey` = indexed by key KEEPING
// disabled flags in (distinguishes known-but-off from unknown), `groupTypeMapping` = {} (every flag
// person-buckets in v1), `cohorts` = {} (no cohort refs in v1). Pure — no I/O, no validation (call
// `validateDefinitions` first at the seed boundary). A future adapter writes its own lowering from
// the same neutral type.
export function lowerDefinitions(definitions: readonly FeatureFlagDefinition[]): DefinitionSnapshot {
  const flags = definitions.map(lowerDefinition);
  const flagsByKey = flags.reduce<Record<string, WireFlagDefinition>>((acc, flag) => {
    acc[flag.key] = flag;
    return acc;
  }, {});
  return {
    flags,
    flagsByKey,
    groupTypeMapping: {},
    cohorts: {},
  };
}

function lowerDefinition(definition: FeatureFlagDefinition): WireFlagDefinition {
  const filters: NonNullable<WireFlagDefinition['filters']> = {};
  if (definition.conditions !== undefined) {
    filters.groups = definition.conditions.map(lowerCondition);
  }
  if (definition.variants !== undefined) {
    filters.multivariate = { variants: definition.variants.map(lowerVariant) };
  }
  if (definition.payloads !== undefined) {
    filters.payloads = definition.payloads;
  }
  return {
    key: definition.key,
    active: definition.enabled,
    filters,
  };
}

function lowerCondition(condition: FlagCondition): WireFlagCondition {
  const group: WireFlagCondition = {};
  if (condition.propertyFilters !== undefined) {
    group.properties = condition.propertyFilters.map(lowerPropertyFilter);
  }
  if (condition.rolloutPercentage !== undefined) {
    group.rollout_percentage = condition.rolloutPercentage;
  }
  if (condition.variantOverride !== undefined) {
    group.variant = condition.variantOverride;
  }
  return group;
}

// Lower one property filter. NEVER emits a `type`, so the plain-property `matchProperty` path runs
// (a cohort/flag `type` is scoped out of neutral v1).
function lowerPropertyFilter(filter: PropertyFilter): WireFlagProperty {
  const wire: WireFlagProperty = {
    key: filter.property,
    operator: filter.operator ?? DEFAULT_OPERATOR,
    value: filter.value,
  };
  if (filter.negated !== undefined) {
    wire.negation = filter.negated;
  }
  return wire;
}

function lowerVariant(variant: FlagVariant): WireFlagVariant {
  return { key: variant.key, rollout_percentage: variant.rolloutPercentage };
}
