import { defineTaxonomy } from 'analytics-kit';
import { expect, expectTypeOf, test } from 'vitest';
import { createAnalytics } from './create-analytics';
import type { NodeAnalytics } from './node-analytics';

const analytics = createAnalytics({
  taxonomy: defineTaxonomy({
    events: {
      order_placed: { amount: 'number' },
      logged_out: {},
    },
    traits: { plan: 'string', seats: 'number' },
    groups: {
      company: { name: 'string', size: 'number' },
    },
  }),
});

// Compile-time assertions only. `tsc --noEmit` — the typecheck gate (its `include` is
// `src`) — validates every `@ts-expect-error` and the well-typed calls WITHOUT running
// them. The bodies are never invoked: an executed off-list call would trip the runtime
// allowlist guard, which is a separate (runtime) concern proven in node-analytics.test.ts.
const _declaredEventTypeChecks = (): void => {
  analytics.capture('user-1', 'order_placed', { amount: 42 });
  analytics.capture('user-1', 'order_placed', { amount: 42 }, { dedupeId: 'd' });
};

const _rejectsWrongProps = (): void => {
  // @ts-expect-error 'checkout' is not a declared event
  analytics.capture('user-1', 'checkout', { amount: 1 });
  // @ts-expect-error amount must be a number, not a string
  analytics.capture('user-1', 'order_placed', { amount: 'lots' });
  // @ts-expect-error rogue is not a declared prop of order_placed
  analytics.capture('user-1', 'order_placed', { amount: 1, rogue: 'x' });
};

const _requiresDeclaredProps = (): void => {
  // @ts-expect-error order_placed declares props, so they are required
  analytics.capture('user-1', 'order_placed');
};

const _noPropsEventIsOptional = (): void => {
  analytics.capture('user-1', 'logged_out');
  analytics.capture('user-1', 'logged_out', { dedupeId: 'd' });
};

const _distinctIdRequired = (): void => {
  // @ts-expect-error distinctId is required (no zero-arg / event-first form)
  analytics.capture('order_placed', { amount: 1 });
  // @ts-expect-error distinctId cannot be omitted
  analytics.capture();
};

const _bareUntypedCaptures = (): void => {
  const loose = createAnalytics({});
  loose.capture('user-1', 'any_event', { any: 'prop' });
  loose.capture('user-1', 'any_event');
};

const _setTraitsTypedOffTaxonomy = (): void => {
  analytics.setTraits('user-1', { plan: 'pro', seats: 5 });
  analytics.setTraits('user-1', { plan: 'pro', seats: 5 }, true);
};

const _rejectsWrongTraits = (): void => {
  // @ts-expect-error seats must be a number, not a string
  analytics.setTraits('user-1', { seats: 'lots' });
  // @ts-expect-error rogue is not a declared trait
  analytics.setTraits('user-1', { rogue: 'x' });
  // @ts-expect-error once is a boolean flag, not a second trait bag
  analytics.setTraits('user-1', { plan: 'pro' }, { plan: 'pro' });
};

const _setGroupTraitsTypedOffTaxonomy = (): void => {
  analytics.setGroupTraits('company', 'acme', { name: 'Acme', size: 200 });
};

const _rejectsWrongGroupTraits = (): void => {
  // @ts-expect-error 'team' is not a declared group type
  analytics.setGroupTraits('team', 'acme', { name: 'Acme' });
  // @ts-expect-error size must be a number, not a string
  analytics.setGroupTraits('company', 'acme', { size: 'big' });
  // @ts-expect-error rogue is not a declared trait of the company group
  analytics.setGroupTraits('company', 'acme', { rogue: 'x' });
};

test('taxonomy-typing compile-time pins are present (validated by tsc, not executed)', () => {
  expect([
    _declaredEventTypeChecks,
    _rejectsWrongProps,
    _requiresDeclaredProps,
    _noPropsEventIsOptional,
    _distinctIdRequired,
    _bareUntypedCaptures,
    _setTraitsTypedOffTaxonomy,
    _rejectsWrongTraits,
    _setGroupTraitsTypedOffTaxonomy,
    _rejectsWrongGroupTraits,
  ]).toHaveLength(10);
});

test('NodeAnalytics exposes exactly its own narrow server surface', () => {
  expectTypeOf<keyof NodeAnalytics<never>>().toEqualTypeOf<
    'capture' | 'setTraits' | 'setGroupTraits' | 'flush' | 'shutdown'
  >();
  expectTypeOf<NodeAnalytics<never>['flush']>().returns.toEqualTypeOf<Promise<void>>();
  expectTypeOf<NodeAnalytics<never>['shutdown']>().returns.toEqualTypeOf<Promise<void>>();
});
