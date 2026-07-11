import { expectTypeOf, test } from 'vitest';
import type { RootAnalytics, ShapeOf } from '@randomtoni/analytics-kit';
import { createFernlyAnalytics } from './harness';
import { fernlyTaxonomy } from './taxonomy';

test('the keyed harness returns a taxonomy-typed RootAnalytics<ShapeOf<FernlyTaxonomy>>', () => {
  const { analytics } = createFernlyAnalytics({ key: 'k' });
  expectTypeOf(analytics).toEqualTypeOf<
    RootAnalytics<ShapeOf<(typeof fernlyTaxonomy)['decl']>>
  >();
});

test('a declared event with correct props type-checks', () => {
  const { analytics } = createFernlyAnalytics({ key: 'k' });

  analytics.track('signup_started');
  analytics.track('signup_completed', { plan: 'pro' });
  analytics.track('document_uploaded', { documentId: 'd1', sizeBytes: 2048 });
  analytics.track('review_requested', { documentId: 'd1', reviewerId: 'r1' });
  analytics.track('comment_added', { documentId: 'd1', resolved: false });
  analytics.track('review_completed', { documentId: 'd1', approved: true });
  analytics.track('plan_upgraded', { fromPlan: 'free', toPlan: 'pro', at: new Date() });

  // ShapeOf resolves each event's prop tags to their runtime types.
  expectTypeOf<ShapeOf<(typeof fernlyTaxonomy)['decl']>['events']['document_uploaded']>().toEqualTypeOf<
    { documentId: string; sizeBytes: number }
  >();
  expectTypeOf<ShapeOf<(typeof fernlyTaxonomy)['decl']>['events']['plan_upgraded']>().toEqualTypeOf<
    { fromPlan: string; toPlan: string; at: Date }
  >();
});

test('a declared event with props omitted is a compile error (props are required, not omittable)', () => {
  const { analytics } = createFernlyAnalytics({ key: 'k' });

  // @ts-expect-error signup_completed declares props, so they are required
  analytics.track('signup_completed');
});

test('a wrong-typed prop is a compile error', () => {
  const { analytics } = createFernlyAnalytics({ key: 'k' });

  // @ts-expect-error sizeBytes must be a number, not a string
  analytics.track('document_uploaded', { documentId: 'd1', sizeBytes: 'big' });
  // @ts-expect-error approved must be a boolean, not a string
  analytics.track('review_completed', { documentId: 'd1', approved: 'yes' });
});

test('an unknown event name is a compile error', () => {
  const { analytics } = createFernlyAnalytics({ key: 'k' });

  // @ts-expect-error 'checkout' is not a declared Fernly event
  analytics.track('checkout', { plan: 'pro' });
});

test('reserved page/pageleave names cannot be declared as events (typed-out of events)', () => {
  const { analytics } = createFernlyAnalytics({ key: 'k' });

  // @ts-expect-error 'pageleave' is not a declared Fernly event (reserved, not in the taxonomy)
  analytics.track('pageleave');
});

test('declared traits and groups narrow identify / setTraits / group', () => {
  const { analytics } = createFernlyAnalytics({ key: 'k' });

  analytics.identify('reviewer-1', { role: 'reviewer', plan: 'pro' }, { email: 'r@fernly.example' });
  analytics.setTraits({ role: 'admin' });
  analytics.group('workspace', 'w1', { name: 'Acme', seats: 12 });
  analytics.group('team', 't1', { name: 'Legal' });

  // @ts-expect-error role must be a string
  analytics.identify('reviewer-1', { role: 5 });
  // @ts-expect-error 'company' is not a declared Fernly group
  analytics.group('company', 'c1');
  // @ts-expect-error seats must be a number
  analytics.group('workspace', 'w1', { name: 'Acme', seats: 'many' });
});

test('a consumer-supplied taxonomy flows its own ShapeOf through the harness (bar B: generics only)', () => {
  const { analytics } = createFernlyAnalytics({
    key: 'k',
    taxonomy: fernlyTaxonomy,
  });

  analytics.page('doc', { path: '/doc/1', referrer: '/inbox' });
  // @ts-expect-error path must be a string
  analytics.page('doc', { path: 3 });
});
