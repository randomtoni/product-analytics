import type {
  FeatureFlagDefinition,
  FlagCondition,
  FlagFilterOperator,
  FlagVariant,
} from './neutral-definition';

// Seed-time input-boundary validation for neutral flag definitions — run at the lowering entry so a
// bad definition fails LOUDLY at client construction, not lazily at first eval. Rejections throw a
// plain `Error` carrying ALL violations (the same error type the node config layer throws for a bad
// config — e.g. `createReceiverFromConfig`; there is no runtime schema on `FlagClientConfig`, so a
// config-boundary failure is a plain `Error`). The dead-`'false'`-payload-key is a diagnostic, never
// a rejection — it is emitted as a dev-time warning, structurally distinct from the throw path.

// The closed set of property-comparison operators the operator engine handles — the runtime mirror of
// the `FlagFilterOperator` union, used to reject an operator outside it at seed time.
const ALLOWED_OPERATORS: ReadonlySet<FlagFilterOperator> = new Set<FlagFilterOperator>([
  'exact',
  'is_not',
  'is_set',
  'is_not_set',
  'icontains',
  'not_icontains',
  'regex',
  'not_regex',
  'gt',
  'gte',
  'lt',
  'lte',
  'is_date_before',
  'is_date_after',
  'semver_eq',
  'semver_neq',
  'semver_gt',
  'semver_gte',
  'semver_lt',
  'semver_lte',
  'semver_tilde',
  'semver_caret',
  'semver_wildcard',
]);

const ROLLOUT_MIN = 0;
const ROLLOUT_MAX = 100;

// The header the aggregated reject message leads with (message-as-named-const, mirroring the node
// config-factory precedent).
export const INVALID_DEFINITIONS_MESSAGE = 'analytics: invalid flag definitions supplied at seed time';

// Validate a neutral definition set, throwing a plain `Error` listing every violation when any is
// found. A valid set returns void. Call before `lowerDefinitions` at the seed boundary. Also emits a
// dev-time WARN (never a rejection) for a dead `'false'` payload key.
export function validateDefinitions(definitions: readonly FeatureFlagDefinition[]): void {
  const violations: string[] = [];
  const seenKeys = new Set<string>();

  for (let i = 0; i < definitions.length; i++) {
    const definition = definitions[i];
    const label = definitionLabel(definition, i);

    if (typeof definition.key !== 'string' || definition.key.trim() === '') {
      violations.push(`${label}: 'key' must be a non-empty string.`);
    } else if (seenKeys.has(definition.key)) {
      violations.push(`${label}: duplicate key '${definition.key}'.`);
    } else {
      seenKeys.add(definition.key);
    }

    const declaredVariantKeys = collectVariantKeys(definition.variants, label, violations);
    validateConditions(definition.conditions, declaredVariantKeys, label, violations);
    warnDeadFalsePayloadKey(definition, label);
  }

  if (violations.length > 0) {
    throw new Error(`${INVALID_DEFINITIONS_MESSAGE}:\n- ${violations.join('\n- ')}`);
  }
}

function definitionLabel(definition: FeatureFlagDefinition, index: number): string {
  const key = typeof definition.key === 'string' && definition.key.trim() !== '' ? definition.key : `#${index}`;
  return `flag '${key}'`;
}

// Validate the multivariate variants, returning the set of DECLARED variant keys (for
// `variantOverride` membership). An absent `variants` is a boolean flag (no variants to check). A
// present-but-empty array, an empty variant key, an out-of-range band, or bands summing > 100 are
// violations; bands summing < 100 are legal (the gap ⇒ bare `true`).
function collectVariantKeys(
  variants: FlagVariant[] | undefined,
  label: string,
  violations: string[]
): ReadonlySet<string> {
  const keys = new Set<string>();
  if (variants === undefined) {
    return keys;
  }
  if (variants.length === 0) {
    violations.push(`${label}: 'variants' is present but empty — omit it for a boolean flag.`);
    return keys;
  }
  let bandSum = 0;
  for (const variant of variants) {
    if (typeof variant.key !== 'string' || variant.key.trim() === '') {
      violations.push(`${label}: a variant has an empty 'key'.`);
    } else {
      keys.add(variant.key);
    }
    if (!inRolloutRange(variant.rolloutPercentage)) {
      violations.push(
        `${label}: variant '${variant.key}' rolloutPercentage ${String(variant.rolloutPercentage)} is outside 0..100.`
      );
    }
    bandSum += variant.rolloutPercentage;
  }
  if (bandSum > ROLLOUT_MAX) {
    violations.push(`${label}: variant rolloutPercentage bands sum to ${bandSum} (> 100).`);
  }
  return keys;
}

function validateConditions(
  conditions: FlagCondition[] | undefined,
  declaredVariantKeys: ReadonlySet<string>,
  label: string,
  violations: string[]
): void {
  if (conditions === undefined) {
    return;
  }
  for (const condition of conditions) {
    if (condition.rolloutPercentage !== undefined && !inRolloutRange(condition.rolloutPercentage)) {
      violations.push(
        `${label}: condition rolloutPercentage ${String(condition.rolloutPercentage)} is outside 0..100.`
      );
    }
    if (
      condition.variantOverride !== undefined &&
      !declaredVariantKeys.has(condition.variantOverride)
    ) {
      violations.push(
        `${label}: variantOverride '${condition.variantOverride}' names no declared variant.`
      );
    }
    for (const filter of condition.propertyFilters ?? []) {
      if (filter.operator !== undefined && !ALLOWED_OPERATORS.has(filter.operator)) {
        violations.push(`${label}: unknown operator '${String(filter.operator)}'.`);
      }
    }
  }
}

function inRolloutRange(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= ROLLOUT_MIN && value <= ROLLOUT_MAX;
}

// Emit a DEV-TIME warning (never a rejection) when a definition carries a `'false'` payload key: that
// key is unreachable under local eval (the resolver returns early on a false-resolved flag before any
// payload lookup), so it is almost always a consumer mistake — but it round-trips harmlessly from a
// remote source, so rejecting it would introduce a static-vs-remote asymmetry. The reachability is an
// adapter-internal mechanic of THIS resolver's early-return, not a neutral-contract invariant.
function warnDeadFalsePayloadKey(definition: FeatureFlagDefinition, label: string): void {
  if (definition.payloads !== undefined && 'false' in definition.payloads) {
    console.warn(
      `analytics: ${label} has a 'false' payload key, which is never reached under local evaluation (an off-state flag carries no payload). It will be ignored. Remove it or key the payload by a variant/'true' value.`
    );
  }
}
