import { expect, expectTypeOf, test } from 'vitest';
import { createAnalytics } from './create-analytics';
import { defineTaxonomy } from './taxonomy';
import type { PropDecl, PropType, ShapeOf, TaxonomyDecl } from './taxonomy';

test('defineTaxonomy returns an object exposing decl as a runtime registry (what S3 walks)', () => {
  const tx = defineTaxonomy({
    events: { signed_up: { plan: 'string', seats: 'number' }, logged_out: {} },
    traits: { role: 'string' },
    groups: { workspace: { tier: 'string' } },
  });

  expect(Object.keys(tx.decl.events)).toEqual(['signed_up', 'logged_out']);
  expect(tx.decl.events.signed_up).toEqual({ plan: 'string', seats: 'number' });
  expect(Object.keys(tx.decl.events.signed_up)).toEqual(['plan', 'seats']);
  expect(tx.decl.traits).toEqual({ role: 'string' });
  expect(Object.keys(tx.decl.groups)).toEqual(['workspace']);
});

test('the const type parameter narrows the decl to literals, not widened strings', () => {
  const tx = defineTaxonomy({ events: { signed_up: { plan: 'string' } } });

  expectTypeOf(tx.decl.events.signed_up.plan).toEqualTypeOf<'string'>();
});

test('a supplied taxonomy types track: declared events with resolved prop types compile', () => {
  const analytics = createAnalytics({
    taxonomy: defineTaxonomy({
      events: { signed_up: { plan: 'string', seats: 'number', active: 'boolean', at: 'date' } },
    }),
  });

  analytics.track('signed_up', { plan: 'pro', seats: 3, active: true, at: new Date() });
  expectTypeOf(analytics.track)
    .parameter(1)
    .toEqualTypeOf<{ plan: string; seats: number; active: boolean; at: Date }>();
});

test('an undeclared event and a wrong prop type are compile errors', () => {
  const analytics = createAnalytics({
    taxonomy: defineTaxonomy({ events: { signed_up: { plan: 'string' } } }),
  });

  // @ts-expect-error 'checkout' is not a declared event
  analytics.track('checkout', { plan: 'pro' });
  // @ts-expect-error plan must be a string, not a number
  analytics.track('signed_up', { plan: 3 });
  // @ts-expect-error signed_up declares props, so they are required (not omittable)
  analytics.track('signed_up');
});

test('a no-prop declared event allows track(event) with props omitted (not a forced {})', () => {
  const analytics = createAnalytics({
    taxonomy: defineTaxonomy({ events: { logged_out: {} } }),
  });

  analytics.track('logged_out');
  expect(true).toBe(true);
});

test('bar B: an untyped createAnalytics({}) still compiles and track(x) needs no props arg', () => {
  const analytics = createAnalytics({});

  analytics.track('x');
  analytics.track('x', { a: 1 });
  expectTypeOf(analytics.track).toBeCallableWith('any_event_name');
});

test('group and identify/setTraits narrow to the declared groups/traits shapes', () => {
  const analytics = createAnalytics({
    taxonomy: defineTaxonomy({
      events: { e: {} },
      traits: { role: 'string', level: 'number' },
      groups: { workspace: { tier: 'string' } },
    }),
  });

  analytics.identify('u1', { role: 'admin' }, { level: 2 });
  analytics.setTraits({ role: 'admin' });
  analytics.group('workspace', 'w1', { tier: 'pro' });

  // @ts-expect-error role must be a string
  analytics.identify('u1', { role: 5 });
  // @ts-expect-error 'company' is not a declared group
  analytics.group('company', 'c1');
  // @ts-expect-error tier must be a string
  analytics.group('workspace', 'w1', { tier: 5 });
});

test('a taxonomy with only events still compiles identify/setTraits/group (absent slots filled)', () => {
  const analytics = createAnalytics({
    taxonomy: defineTaxonomy({ events: { ping: {} } }),
  });

  analytics.identify('u1', { anything: 'goes' });
  analytics.setTraits({ anything: 'goes' });
  analytics.group('any-group', 'g1', { seats: 10 });
  expect(true).toBe(true);
});

test('declaring an event under the reserved page name is a compile error', () => {
  // @ts-expect-error 'page' is the reserved page-event slot and cannot be a declared event
  defineTaxonomy({ events: { page: { url: 'string' } } });
  expect(true).toBe(true);
});

test('declaring an event under the reserved pageleave name is a compile error (E6-S2)', () => {
  // @ts-expect-error 'pageleave' is the reserved pageleave-event slot and cannot be a declared event
  defineTaxonomy({ events: { pageleave: { url: 'string' } } });
  expect(true).toBe(true);
});

test('ShapeOf resolves prop type-tags to their runtime types', () => {
  type Decl = { events: { e: { a: 'string'; b: 'number' } } };
  expectTypeOf<ShapeOf<Decl>['events']['e']>().toEqualTypeOf<{ a: string; b: number }>();
});

test('ShapeOf.page resolves a declared page shape and defaults to NeutralProperties (E6-S1)', () => {
  type Declared = { events: { e: Record<string, never> }; page: { path: 'string'; referrer: 'string' } };
  expectTypeOf<ShapeOf<Declared>['page']>().toEqualTypeOf<{ path: string; referrer: string }>();

  type NoPage = { events: { e: Record<string, never> } };
  expectTypeOf<ShapeOf<NoPage>['page']>().toEqualTypeOf<Record<string, unknown>>();
});

test('page() type-checks a taxonomy-declared page shape and rejects wrong prop types (E6-S1)', () => {
  const analytics = createAnalytics({
    taxonomy: defineTaxonomy({
      events: { e: {} },
      page: { path: 'string', referrer: 'string' },
    }),
  });

  analytics.page('home', { path: '/home', referrer: '/landing' });
  expectTypeOf(analytics.page).parameter(1).toEqualTypeOf<
    { path: string; referrer: string } | undefined
  >();

  // @ts-expect-error path must be a string, not a number
  analytics.page('home', { path: 3 });
  // @ts-expect-error 'title' is not a declared page prop
  analytics.page('home', { title: 'x' });
});

test('page() defaults to NeutralProperties (any props) when the taxonomy declares no page shape (E6-S1)', () => {
  const analytics = createAnalytics({
    taxonomy: defineTaxonomy({ events: { e: {} } }),
  });

  analytics.page();
  analytics.page('home');
  analytics.page('home', { anything: 'goes', count: 3 });
  expectTypeOf(analytics.page).parameter(1).toEqualTypeOf<Record<string, unknown> | undefined>();
});

test('bar B: an untyped createAnalytics({}) keeps page(name?, props?) loose (E6-S1)', () => {
  const analytics = createAnalytics({});

  analytics.page();
  analytics.page('home', { any: 'prop' });
  expectTypeOf(analytics.page).parameter(1).toEqualTypeOf<Record<string, unknown> | undefined>();
});

test('PropType and PropDecl are the declaration vocabulary', () => {
  expectTypeOf<PropType>().toEqualTypeOf<'string' | 'number' | 'boolean' | 'date'>();
  expectTypeOf<PropDecl>().toEqualTypeOf<Record<string, PropType>>();
  const decl: TaxonomyDecl = { events: { e: {} } };
  expect(decl.events.e).toEqual({});
});
