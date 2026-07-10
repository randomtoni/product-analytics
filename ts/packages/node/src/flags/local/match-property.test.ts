import { describe, expect, test } from 'vitest';
import { matchProperty } from './match-property';
import { InconclusiveMatchError } from './errors';
import type { FlagProperty } from './definition-types';

function prop(p: Partial<FlagProperty> & { key: string; value: FlagProperty['value'] }): FlagProperty {
  return p;
}

describe('default operator is exact', () => {
  test('a property with no operator matches by exact (case-insensitive)', () => {
    expect(matchProperty(prop({ key: 'plan', value: 'Pro' }), { plan: 'pro' })).toBe(true);
    expect(matchProperty(prop({ key: 'plan', value: 'Pro' }), { plan: 'free' })).toBe(false);
  });
});

describe('exact / is_not (case-insensitive, array membership)', () => {
  test('exact matches and rejects', () => {
    expect(matchProperty(prop({ key: 'c', value: 'US', operator: 'exact' }), { c: 'us' })).toBe(true);
    expect(matchProperty(prop({ key: 'c', value: 'US', operator: 'exact' }), { c: 'gb' })).toBe(false);
  });
  test('exact array membership', () => {
    expect(matchProperty(prop({ key: 'c', value: ['US', 'GB'], operator: 'exact' }), { c: 'gb' })).toBe(true);
    expect(matchProperty(prop({ key: 'c', value: ['US', 'GB'], operator: 'exact' }), { c: 'fr' })).toBe(false);
  });
  test('is_not inverts', () => {
    expect(matchProperty(prop({ key: 'c', value: 'US', operator: 'is_not' }), { c: 'gb' })).toBe(true);
    expect(matchProperty(prop({ key: 'c', value: 'US', operator: 'is_not' }), { c: 'us' })).toBe(false);
  });
});

describe('is_set / is_not_set (key presence, resolves locally)', () => {
  test('is_set on a present key matches; is_not_set on a present key rejects', () => {
    expect(matchProperty(prop({ key: 'plan', value: true, operator: 'is_set' }), { plan: 'pro' })).toBe(true);
    expect(matchProperty(prop({ key: 'plan', value: true, operator: 'is_not_set' }), { plan: 'pro' })).toBe(false);
  });
  test('is_not_set on an ABSENT key resolves locally to true (does not throw)', () => {
    expect(matchProperty(prop({ key: 'missing', value: true, operator: 'is_not_set' }), {})).toBe(true);
  });
});

describe('icontains / not_icontains', () => {
  test('icontains matches and rejects', () => {
    expect(matchProperty(prop({ key: 'e', value: 'ACME', operator: 'icontains' }), { e: 'bob@acme.com' })).toBe(true);
    expect(matchProperty(prop({ key: 'e', value: 'zzz', operator: 'icontains' }), { e: 'bob@acme.com' })).toBe(false);
  });
  test('not_icontains inverts', () => {
    expect(matchProperty(prop({ key: 'e', value: 'zzz', operator: 'not_icontains' }), { e: 'bob@acme.com' })).toBe(true);
    expect(matchProperty(prop({ key: 'e', value: 'acme', operator: 'not_icontains' }), { e: 'bob@acme.com' })).toBe(false);
  });
});

describe('regex / not_regex', () => {
  test('regex matches and rejects', () => {
    expect(matchProperty(prop({ key: 'e', value: '@acme\\.com$', operator: 'regex' }), { e: 'a@acme.com' })).toBe(true);
    expect(matchProperty(prop({ key: 'e', value: '@acme\\.com$', operator: 'regex' }), { e: 'a@other.com' })).toBe(false);
  });
  test('not_regex inverts', () => {
    expect(matchProperty(prop({ key: 'e', value: '@acme\\.com$', operator: 'not_regex' }), { e: 'a@other.com' })).toBe(true);
    expect(matchProperty(prop({ key: 'e', value: '@acme\\.com$', operator: 'not_regex' }), { e: 'a@acme.com' })).toBe(false);
  });
  test('an invalid regex fails the comparison (never throws)', () => {
    expect(matchProperty(prop({ key: 'e', value: '(', operator: 'regex' }), { e: 'x' })).toBe(false);
    expect(matchProperty(prop({ key: 'e', value: '(', operator: 'not_regex' }), { e: 'x' })).toBe(false);
  });
});

describe('gt / gte / lt / lte (numeric then lexicographic)', () => {
  test('numeric comparison, including the string-"10" > "9" numeric case', () => {
    expect(matchProperty(prop({ key: 'n', value: 5, operator: 'gt' }), { n: 10 })).toBe(true);
    expect(matchProperty(prop({ key: 'n', value: 5, operator: 'gt' }), { n: 3 })).toBe(false);
    expect(matchProperty(prop({ key: 'n', value: '9', operator: 'gt' }), { n: '10' })).toBe(true);
  });
  test('gte / lt / lte boundaries', () => {
    expect(matchProperty(prop({ key: 'n', value: 5, operator: 'gte' }), { n: 5 })).toBe(true);
    expect(matchProperty(prop({ key: 'n', value: 5, operator: 'lt' }), { n: 4 })).toBe(true);
    expect(matchProperty(prop({ key: 'n', value: 5, operator: 'lte' }), { n: 6 })).toBe(false);
  });
  test('falls back to lexicographic when a side is non-numeric (actor OP filter)', () => {
    // The comparison is `overrideValue OP value` (actor value on the left): "apple" < "banana".
    expect(matchProperty(prop({ key: 's', value: 'banana', operator: 'lt' }), { s: 'apple' })).toBe(true);
    expect(matchProperty(prop({ key: 's', value: 'apple', operator: 'lt' }), { s: 'banana' })).toBe(false);
  });
});

describe('is_date_before / is_date_after (incl. relative dates)', () => {
  test('absolute date comparison', () => {
    expect(matchProperty(prop({ key: 'd', value: '2020-01-01', operator: 'is_date_after' }), { d: '2021-01-01' })).toBe(true);
    expect(matchProperty(prop({ key: 'd', value: '2020-01-01', operator: 'is_date_before' }), { d: '2019-01-01' })).toBe(true);
    expect(matchProperty(prop({ key: 'd', value: '2020-01-01', operator: 'is_date_after' }), { d: '2019-01-01' })).toBe(false);
  });
  test('relative date -30d: a very old date is before, a future date is after', () => {
    expect(matchProperty(prop({ key: 'd', value: '-30d', operator: 'is_date_before' }), { d: '2000-01-01' })).toBe(true);
    expect(matchProperty(prop({ key: 'd', value: '-30d', operator: 'is_date_after' }), { d: '2999-01-01' })).toBe(true);
  });
  test('a boolean filter value throws inconclusive', () => {
    expect(() =>
      matchProperty(prop({ key: 'd', value: true, operator: 'is_date_after' }), { d: '2021-01-01' })
    ).toThrow(InconclusiveMatchError);
  });
  test('an unparseable actor date throws inconclusive', () => {
    expect(() =>
      matchProperty(prop({ key: 'd', value: '2020-01-01', operator: 'is_date_after' }), { d: 'not-a-date' })
    ).toThrow(InconclusiveMatchError);
  });
});

describe('semver_* family', () => {
  test('eq / neq', () => {
    expect(matchProperty(prop({ key: 'v', value: '1.2.3', operator: 'semver_eq' }), { v: '1.2.3' })).toBe(true);
    expect(matchProperty(prop({ key: 'v', value: '1.2.3', operator: 'semver_neq' }), { v: '1.2.4' })).toBe(true);
    expect(matchProperty(prop({ key: 'v', value: '1.2.3', operator: 'semver_eq' }), { v: '1.2.4' })).toBe(false);
  });
  test('gt / gte / lt / lte', () => {
    expect(matchProperty(prop({ key: 'v', value: '1.2.3', operator: 'semver_gt' }), { v: '1.3.0' })).toBe(true);
    expect(matchProperty(prop({ key: 'v', value: '1.2.3', operator: 'semver_gte' }), { v: '1.2.3' })).toBe(true);
    expect(matchProperty(prop({ key: 'v', value: '2.0.0', operator: 'semver_lt' }), { v: '1.9.9' })).toBe(true);
    expect(matchProperty(prop({ key: 'v', value: '1.2.3', operator: 'semver_lte' }), { v: '1.2.4' })).toBe(false);
  });
  test('tilde / caret / wildcard bounds', () => {
    expect(matchProperty(prop({ key: 'v', value: '1.2.3', operator: 'semver_tilde' }), { v: '1.2.9' })).toBe(true);
    expect(matchProperty(prop({ key: 'v', value: '1.2.3', operator: 'semver_tilde' }), { v: '1.3.0' })).toBe(false);
    expect(matchProperty(prop({ key: 'v', value: '1.2.3', operator: 'semver_caret' }), { v: '1.9.0' })).toBe(true);
    expect(matchProperty(prop({ key: 'v', value: '1.2.3', operator: 'semver_caret' }), { v: '2.0.0' })).toBe(false);
    expect(matchProperty(prop({ key: 'v', value: '1.2.*', operator: 'semver_wildcard' }), { v: '1.2.7' })).toBe(true);
    expect(matchProperty(prop({ key: 'v', value: '1.2.*', operator: 'semver_wildcard' }), { v: '1.3.0' })).toBe(false);
  });
  test('an invalid semver throws inconclusive', () => {
    expect(() =>
      matchProperty(prop({ key: 'v', value: 'not.a.semver', operator: 'semver_eq' }), { v: '1.0.0' })
    ).toThrow(InconclusiveMatchError);
  });
});

describe('inconclusive / null behavior', () => {
  test('a genuinely-missing property under a value operator throws inconclusive', () => {
    expect(() =>
      matchProperty(prop({ key: 'missing', value: 'x', operator: 'exact' }), {})
    ).toThrow(InconclusiveMatchError);
  });
  test('a null actor value fails the comparison (not inconclusive) under a value operator', () => {
    expect(matchProperty(prop({ key: 'x', value: 'y', operator: 'exact' }), { x: null })).toBe(false);
  });
  test('is_not may compare against a null actor value', () => {
    expect(matchProperty(prop({ key: 'x', value: 'y', operator: 'is_not' }), { x: null })).toBe(true);
  });
  test('an unknown operator throws inconclusive', () => {
    expect(() =>
      matchProperty(prop({ key: 'x', value: 'y', operator: 'no_such_op' }), { x: 'y' })
    ).toThrow(InconclusiveMatchError);
  });
});
