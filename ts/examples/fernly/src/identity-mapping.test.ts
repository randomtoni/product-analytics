import { describe, expect, it } from 'vitest';
import { createFernlyAnalytics } from './harness';

describe('Fernly identity mapping onto the neutral primitives', () => {
  it('maps a reviewer onto a distinct id via identify(id, traits, traitsOnce)', () => {
    const { analytics, recorder } = createFernlyAnalytics({ key: 'k' });

    analytics.identify(
      'reviewer-42',
      { role: 'reviewer', plan: 'pro' },
      { email: 'reviewer@fernly.example' }
    );

    expect(recorder.identifies).toEqual([
      {
        distinctId: 'reviewer-42',
        traits: { role: 'reviewer', plan: 'pro' },
        traitsOnce: { email: 'reviewer@fernly.example' },
      },
    ]);
  });

  it('maps a workspace onto group("workspace", key, props)', () => {
    const { analytics, recorder } = createFernlyAnalytics({ key: 'k' });

    analytics.group('workspace', 'ws-acme', { name: 'Acme', seats: 12 });

    expect(recorder.groups).toEqual([
      { type: 'workspace', key: 'ws-acme', traits: { name: 'Acme', seats: 12 } },
    ]);
  });

  it('maps a team onto group("team", key, props)', () => {
    const { analytics, recorder } = createFernlyAnalytics({ key: 'k' });

    analytics.group('team', 'team-legal', { name: 'Legal' });

    expect(recorder.groups).toEqual([
      { type: 'team', key: 'team-legal', traits: { name: 'Legal' } },
    ]);
  });

  it('maps a role onto a trait via setTraits({ role }), routed through identify on the current distinct id', () => {
    const { analytics, recorder } = createFernlyAnalytics({ key: 'k' });
    analytics.identify('reviewer-42', { plan: 'pro' });
    const currentDistinctId = recorder.getDistinctId();

    analytics.setTraits({ role: 'admin' });

    const last = recorder.identifies.at(-1)!;
    expect(last).toEqual({
      distinctId: currentDistinctId,
      traits: { role: 'admin' },
      traitsOnce: undefined,
    });
  });

  it('maps a first-touch role onto setTraits({ role }, true), routed to identify traitsOnce', () => {
    const { analytics, recorder } = createFernlyAnalytics({ key: 'k' });
    analytics.identify('reviewer-42');
    const currentDistinctId = recorder.getDistinctId();

    analytics.setTraits({ role: 'reviewer' }, true);

    const last = recorder.identifies.at(-1)!;
    expect(last).toEqual({
      distinctId: currentDistinctId,
      traits: undefined,
      traitsOnce: { role: 'reviewer' },
    });
  });

  it('carries consumer-defined props on a captured event, not a library concept', () => {
    const { analytics, recorder } = createFernlyAnalytics({ key: 'k' });

    analytics.track('review_requested', { documentId: 'doc-1', reviewerId: 'reviewer-42' });

    expect(recorder.captures).toHaveLength(1);
    expect(recorder.captures[0]!.properties).toEqual({
      documentId: 'doc-1',
      reviewerId: 'reviewer-42',
    });
  });

  it('runs a small identity journey (anonymous -> identify -> group(workspace) -> group(team) -> tracks) and asserts the neutral stream', () => {
    const { analytics, recorder } = createFernlyAnalytics({ key: 'k' });
    const anonymousId = recorder.getDistinctId();

    analytics.track('signup_started');

    analytics.identify('reviewer-42', { role: 'reviewer', plan: 'pro' });
    analytics.group('workspace', 'ws-acme', { name: 'Acme', seats: 12 });
    analytics.group('team', 'team-legal', { name: 'Legal' });

    analytics.track('signup_completed', { plan: 'pro' });
    analytics.track('document_uploaded', { documentId: 'doc-1', sizeBytes: 4096 });

    expect(recorder.identifies).toEqual([
      { distinctId: 'reviewer-42', traits: { role: 'reviewer', plan: 'pro' }, traitsOnce: undefined },
    ]);
    expect(recorder.merges).toEqual([
      { anonymousId, identifiedId: 'reviewer-42' },
    ]);
    expect(recorder.groups).toEqual([
      { type: 'workspace', key: 'ws-acme', traits: { name: 'Acme', seats: 12 } },
      { type: 'team', key: 'team-legal', traits: { name: 'Legal' } },
    ]);
    expect(recorder.captures.map((c) => c.event)).toEqual([
      'signup_started',
      'signup_completed',
      'document_uploaded',
    ]);
    expect(recorder.captures.map((c) => c.distinctId)).toEqual([
      anonymousId,
      'reviewer-42',
      'reviewer-42',
    ]);
  });

  it('records nothing under the unkeyed (no-op) harness — recording bites only on the keyed granting posture', () => {
    const { analytics, recorder } = createFernlyAnalytics();

    analytics.identify('reviewer-42', { role: 'reviewer' });
    analytics.group('workspace', 'ws-acme', { name: 'Acme', seats: 1 });
    analytics.setTraits({ role: 'admin' });

    expect(recorder.identifies).toHaveLength(0);
    expect(recorder.groups).toHaveLength(0);
  });
});
