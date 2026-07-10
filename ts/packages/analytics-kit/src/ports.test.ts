import { expect, expectTypeOf, test } from 'vitest';
import {
  emptyFlagSet,
  type FeatureFlagPort,
  type FlagContext,
  type FlagEvaluateOptions,
  type FlagReason,
  type FlagSet,
  type FlagValue,
} from './ports';
import {
  emptyFlagSet as ExportedEmptyFlagSet,
  type FeatureFlagPort as ExportedFeatureFlagPort,
  type FlagContext as ExportedFlagContext,
  type FlagReason as ExportedFlagReason,
  type FlagSet as ExportedFlagSet,
  type FlagValue as ExportedFlagValue,
} from './index';
import type { ShapeOf } from './taxonomy';

// The taxonomy the port reads narrow against — a variant flag with a typed payload, plus a
// bare boolean gate. Used only for its resolved shape via ShapeOf.
type Decl = {
  events: { e: Record<string, never> };
  flags: {
    checkout_variant: { variants: ['a', 'b']; payload: { discount: 'number' } };
    dark_mode: Record<string, never>;
  };
};
type TX = ShapeOf<Decl>;

test('FlagValue is a variant string or a boolean; FlagReason is the frozen four-member union', () => {
  expectTypeOf<FlagValue>().toEqualTypeOf<string | boolean>();
  expectTypeOf<FlagReason>().toEqualTypeOf<'resolved' | 'bootstrap' | 'stale' | 'unresolved'>();
});

test('FeatureFlagPort exposes exactly evaluate + onChange, no separate reload (E12-S1)', () => {
  expectTypeOf<keyof FeatureFlagPort>().toEqualTypeOf<'evaluate' | 'onChange'>();
});

test('evaluate is async at the boundary and takes an optional context + options bag (E12-S1)', () => {
  expectTypeOf<FeatureFlagPort['evaluate']>().toBeCallableWith();
  expectTypeOf<FeatureFlagPort['evaluate']>().toBeCallableWith({ distinctId: 'u1' });
  expectTypeOf<FeatureFlagPort['evaluate']>().toBeCallableWith(undefined, { refresh: true });
  expectTypeOf<FeatureFlagPort<TX>['evaluate']>().returns.resolves.toEqualTypeOf<FlagSet<TX>>();
});

test('onChange takes a snapshot listener and returns an unsubscribe (E12-S1)', () => {
  expectTypeOf<FeatureFlagPort<TX>['onChange']>().parameter(0).toEqualTypeOf<
    (set: FlagSet<TX>) => void
  >();
  expectTypeOf<FeatureFlagPort['onChange']>().returns.toEqualTypeOf<() => void>();
});

test('FlagContext is exactly the five neutral evaluation fields, refresh is NOT among them (E12-S1)', () => {
  expectTypeOf<keyof FlagContext>().toEqualTypeOf<
    'distinctId' | 'groups' | 'personProperties' | 'groupProperties' | 'flagKeys'
  >();
  expectTypeOf<FlagEvaluateOptions>().toEqualTypeOf<{ refresh?: boolean }>();
});

test('FlagSet snapshot reads narrow off a declared taxonomy flags slot (E12-S1)', () => {
  // The reads are overloaded (a typed-key overload + a loose string fallback), so exercise the
  // NARROWED overload at a literal call site — a string-typed key falls through to the loose one.
  const set = emptyFlagSet<TX>();

  // getFlag('checkout_variant') narrows to the declared variant union | boolean.
  expectTypeOf(set.getFlag('checkout_variant')).toEqualTypeOf<'a' | 'b' | boolean | undefined>();
  // getPayload('checkout_variant') narrows to the declared, resolved payload shape.
  expectTypeOf(set.getPayload('checkout_variant')).toEqualTypeOf<{ discount: number } | undefined>();

  // A bare boolean gate narrows getFlag to boolean (variants: never ⇒ never | boolean) and its
  // payload to unknown (no declared payload).
  expectTypeOf(set.getFlag('dark_mode')).toEqualTypeOf<boolean | undefined>();
  expectTypeOf(set.getPayload('dark_mode')).toEqualTypeOf<unknown>();

  // On the untyped default taxonomy the flags slot is a loose `Record<string, ...>`, so any key
  // resolves through the typed overload against a variant-less, payload-less flag shape: getFlag
  // is boolean (no variants) and getPayload is unknown (no declared payload).
  const untyped = emptyFlagSet();
  expectTypeOf(untyped.getFlag('anything')).toEqualTypeOf<boolean | undefined>();
  expectTypeOf(untyped.getPayload('anything')).toEqualTypeOf<unknown>();
});

test('FlagSet exposes exactly the neutral read surface + degradation signal, nothing vendor-shaped (E12-S1)', () => {
  expectTypeOf<keyof FlagSet>().toEqualTypeOf<
    'isEnabled' | 'getFlag' | 'getPayload' | 'getAll' | 'degraded' | 'reason'
  >();
  expectTypeOf<FlagSet['degraded']>().toEqualTypeOf<boolean>();
  expectTypeOf<FlagSet['reason']>().returns.toEqualTypeOf<FlagReason | undefined>();
});

test('the flag types and emptyFlagSet are re-exported from the package entrypoint (E12-S1)', () => {
  expectTypeOf<ExportedFeatureFlagPort>().toEqualTypeOf<FeatureFlagPort>();
  expectTypeOf<ExportedFlagSet>().toEqualTypeOf<FlagSet>();
  expectTypeOf<ExportedFlagContext>().toEqualTypeOf<FlagContext>();
  expectTypeOf<ExportedFlagValue>().toEqualTypeOf<FlagValue>();
  expectTypeOf<ExportedFlagReason>().toEqualTypeOf<FlagReason>();
  expect(ExportedEmptyFlagSet).toBe(emptyFlagSet);
});

test('emptyFlagSet returns a frozen nothing-resolved snapshot every read of which is callable (E12-S1)', () => {
  const set = emptyFlagSet();

  expect(set.isEnabled('anything')).toBe(false);
  expect(set.getFlag('anything')).toBeUndefined();
  expect(set.getPayload('anything')).toBeUndefined();
  expect(set.getAll()).toEqual({});
  expect(set.degraded).toBe(true);
  expect(set.reason('anything')).toBe('unresolved');
  expect(Object.isFrozen(set)).toBe(true);
});

test('emptyFlagSet is generic and returns the taxonomy-typed snapshot (E12-S1)', () => {
  const set = emptyFlagSet<TX>();
  expectTypeOf(set).toEqualTypeOf<FlagSet<TX>>();
  // Reads still callable and safe on the typed empty snapshot.
  expect(set.isEnabled('checkout_variant')).toBe(false);
  expect(set.getPayload('checkout_variant')).toBeUndefined();
});
