import { InconclusiveMatchError } from './errors';
import type { FlagProperty, PropertyBag } from './definition-types';

// The single-property operator engine, ported VERBATIM in behavior from posthog's node
// `matchProperty` (+ its semver / relative-date helpers) — only the naming is de-branded. A pure,
// synchronous function of (property filter, actor property bag): returns whether the actor's value
// satisfies the filter, or THROWS InconclusiveMatchError when it can't be decided locally (a
// genuinely-absent property under a value operator, a bad regex/date/semver, an unknown operator).
// De-branded from posthog's feature-flags.ts matchProperty / parseSemver / relative-date helpers.

// Operators whose switch case must still run when the actor's value is null/undefined: `is_not`
// may legitimately compare against null; `is_set` only cares about key presence.
const NULL_VALUES_ALLOWED_OPERATORS = ['is_not', 'is_set'];

export function matchProperty(property: FlagProperty, propertyValues: PropertyBag): boolean {
  const key = property.key;
  const value = property.value;
  const operator = property.operator || 'exact';

  if (!(key in propertyValues)) {
    // A genuinely-absent property answers `is_not_set` locally (true) — no need to bail as
    // inconclusive. Any other operator on an absent property IS inconclusive.
    if (operator === 'is_not_set') {
      return true;
    }
    throw new InconclusiveMatchError(`Property ${key} not found in the given properties`);
  } else if (operator === 'is_not_set') {
    return false;
  }

  const overrideValue = propertyValues[key];
  if (
    (overrideValue === null || overrideValue === undefined) &&
    !NULL_VALUES_ALLOWED_OPERATORS.includes(operator)
  ) {
    // The property was provided but is null: fail the comparison. NOT inconclusive — a value was
    // present, it just doesn't satisfy the operator.
    return false;
  }

  switch (operator) {
    case 'exact':
      return computeExactMatch(value, overrideValue);
    case 'is_not':
      return !computeExactMatch(value, overrideValue);
    case 'is_set':
      return key in propertyValues;
    case 'icontains':
      return String(overrideValue).toLowerCase().includes(String(value).toLowerCase());
    case 'not_icontains':
      return !String(overrideValue).toLowerCase().includes(String(value).toLowerCase());
    case 'regex':
      return isValidRegex(String(value)) && String(overrideValue).match(String(value)) !== null;
    case 'not_regex':
      return isValidRegex(String(value)) && String(overrideValue).match(String(value)) === null;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      // Numeric comparison first; fall back to lexicographic only when a side genuinely isn't a
      // number. `Number.isFinite` is the right guard — a NaN from a non-numeric string must not
      // slip into `NaN > 5`. So the string `"10"` compares as `10 > 9` (true), not lexically.
      const parsedValue = typeof value === 'number' ? value : parseFloat(String(value));
      let parsedOverride: number;
      if (typeof overrideValue === 'number') {
        parsedOverride = overrideValue;
      } else if (overrideValue !== null && overrideValue !== undefined) {
        parsedOverride = parseFloat(String(overrideValue));
      } else {
        parsedOverride = NaN;
      }
      if (Number.isFinite(parsedValue) && Number.isFinite(parsedOverride)) {
        return compare(parsedOverride, parsedValue, operator);
      }
      return compare(String(overrideValue), String(value), operator);
    }
    case 'is_date_before':
    case 'is_date_after': {
      if (typeof value === 'boolean') {
        throw new InconclusiveMatchError('Date operations cannot be performed on boolean values');
      }
      let parsedDate = relativeDateParse(String(value));
      if (parsedDate === null) {
        parsedDate = convertToDate(value);
      }
      if (parsedDate === null) {
        throw new InconclusiveMatchError(`Invalid date: ${String(value)}`);
      }
      const overrideDate = convertToDate(overrideValue);
      if (overrideDate === null) {
        throw new InconclusiveMatchError(`Invalid date: ${String(overrideValue)}`);
      }
      if (operator === 'is_date_before') {
        return overrideDate < parsedDate;
      }
      return overrideDate > parsedDate;
    }
    case 'semver_eq':
      return compareSemverTuples(parseSemver(String(overrideValue)), parseSemver(String(value))) === 0;
    case 'semver_neq':
      return compareSemverTuples(parseSemver(String(overrideValue)), parseSemver(String(value))) !== 0;
    case 'semver_gt':
      return compareSemverTuples(parseSemver(String(overrideValue)), parseSemver(String(value))) > 0;
    case 'semver_gte':
      return compareSemverTuples(parseSemver(String(overrideValue)), parseSemver(String(value))) >= 0;
    case 'semver_lt':
      return compareSemverTuples(parseSemver(String(overrideValue)), parseSemver(String(value))) < 0;
    case 'semver_lte':
      return compareSemverTuples(parseSemver(String(overrideValue)), parseSemver(String(value))) <= 0;
    case 'semver_tilde': {
      const parsed = parseSemver(String(overrideValue));
      const { lower, upper } = computeTildeBounds(String(value));
      return compareSemverTuples(parsed, lower) >= 0 && compareSemverTuples(parsed, upper) < 0;
    }
    case 'semver_caret': {
      const parsed = parseSemver(String(overrideValue));
      const { lower, upper } = computeCaretBounds(String(value));
      return compareSemverTuples(parsed, lower) >= 0 && compareSemverTuples(parsed, upper) < 0;
    }
    case 'semver_wildcard': {
      const parsed = parseSemver(String(overrideValue));
      const { lower, upper } = computeWildcardBounds(String(value));
      return compareSemverTuples(parsed, lower) >= 0 && compareSemverTuples(parsed, upper) < 0;
    }
    default:
      throw new InconclusiveMatchError(`Unknown operator: ${operator}`);
  }
}

function computeExactMatch(value: unknown, overrideValue: unknown): boolean {
  if (Array.isArray(value)) {
    return value
      .map((val) => String(val).toLowerCase())
      .includes(String(overrideValue).toLowerCase());
  }
  return String(value).toLowerCase() === String(overrideValue).toLowerCase();
}

function compare(lhs: number | string, rhs: number | string, operator: string): boolean {
  if (operator === 'gt') {
    return lhs > rhs;
  } else if (operator === 'gte') {
    return lhs >= rhs;
  } else if (operator === 'lt') {
    return lhs < rhs;
  } else if (operator === 'lte') {
    return lhs <= rhs;
  }
  throw new Error(`Invalid operator: ${operator}`);
}

function isValidRegex(regex: string): boolean {
  try {
    new RegExp(regex);
    return true;
  } catch {
    return false;
  }
}

function convertToDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (!isNaN(date.valueOf())) {
      return date;
    }
    return null;
  }
  return null;
}

// A relative-date filter like `-30d` / `-6h` / `-2w` / `-3m` / `-1y`, resolved against now (UTC).
// Returns null when the string isn't a relative-date form (the caller then tries an absolute date).
export function relativeDateParse(value: string): Date | null {
  const regex = /^-?(?<number>[0-9]+)(?<interval>[a-z])$/;
  const match = value.match(regex);
  if (!match || !match.groups) {
    return null;
  }
  const number = parseInt(match.groups['number'], 10);
  if (number >= 10000) {
    return null;
  }
  const parsed = new Date(new Date().toISOString());
  const interval = match.groups['interval'];
  if (interval === 'h') {
    parsed.setUTCHours(parsed.getUTCHours() - number);
  } else if (interval === 'd') {
    parsed.setUTCDate(parsed.getUTCDate() - number);
  } else if (interval === 'w') {
    parsed.setUTCDate(parsed.getUTCDate() - number * 7);
  } else if (interval === 'm') {
    parsed.setUTCMonth(parsed.getUTCMonth() - number);
  } else if (interval === 'y') {
    parsed.setUTCFullYear(parsed.getUTCFullYear() - number);
  } else {
    return null;
  }
  return parsed;
}

type SemverTuple = [number, number, number];

function parseSemverNumericIdentifier(part: string, raw: string): number {
  if (!/^\d+$/.test(part)) {
    throw new InconclusiveMatchError(`Invalid semver: ${raw}`);
  }
  if (part.length > 1 && part[0] === '0') {
    throw new InconclusiveMatchError(`Invalid semver: ${raw}`);
  }
  return parseInt(part, 10);
}

// Parse a version string into a [major, minor, patch] tuple: strips whitespace, a `v`/`V` prefix,
// and pre-release/build metadata; defaults missing components to 0; throws on invalid input.
export function parseSemver(value: string): SemverTuple {
  const text = String(value).trim().replace(/^[vV]/, '');
  const baseVersion = text.split('-')[0].split('+')[0];
  if (!baseVersion || baseVersion.startsWith('.')) {
    throw new InconclusiveMatchError(`Invalid semver: ${value}`);
  }
  const parts = baseVersion.split('.');
  const parsePart = (part: string | undefined): number => {
    if (part === undefined || part === '') {
      return 0;
    }
    return parseSemverNumericIdentifier(part, value);
  };
  return [parsePart(parts[0]), parsePart(parts[1]), parsePart(parts[2])];
}

function compareSemverTuples(a: SemverTuple, b: SemverTuple): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

// ~X.Y.Z means >=X.Y.Z and <X.(Y+1).0
function computeTildeBounds(value: string): { lower: SemverTuple; upper: SemverTuple } {
  const parsed = parseSemver(value);
  return { lower: [parsed[0], parsed[1], parsed[2]], upper: [parsed[0], parsed[1] + 1, 0] };
}

// ^X.Y.Z: >=X.Y.Z and <(X+1).0.0 when X>0; <0.(Y+1).0 when X==0,Y>0; else <0.0.(Z+1).
function computeCaretBounds(value: string): { lower: SemverTuple; upper: SemverTuple } {
  const [major, minor, patch] = parseSemver(value);
  const lower: SemverTuple = [major, minor, patch];
  let upper: SemverTuple;
  if (major > 0) {
    upper = [major + 1, 0, 0];
  } else if (minor > 0) {
    upper = [0, minor + 1, 0];
  } else {
    upper = [0, 0, patch + 1];
  }
  return { lower, upper };
}

// "X.*" / "X": >=X.0.0 <(X+1).0.0 ; "X.Y.*": >=X.Y.0 <X.(Y+1).0
function computeWildcardBounds(value: string): { lower: SemverTuple; upper: SemverTuple } {
  const text = String(value).trim().replace(/^[vV]/, '');
  const cleanedText = text.replace(/\.\*$/, '').replace(/\*$/, '');
  if (!cleanedText) {
    throw new InconclusiveMatchError(`Invalid wildcard semver: ${value}`);
  }
  const parts = cleanedText.split('.');
  const parseWildcardPart = (part: string): number => {
    try {
      return parseSemverNumericIdentifier(part, value);
    } catch {
      throw new InconclusiveMatchError(`Invalid wildcard semver: ${value}`);
    }
  };
  const major = parseWildcardPart(parts[0]);
  if (parts.length === 1) {
    return { lower: [major, 0, 0], upper: [major + 1, 0, 0] };
  }
  const minor = parseWildcardPart(parts[1]);
  return { lower: [major, minor, 0], upper: [major, minor + 1, 0] };
}
