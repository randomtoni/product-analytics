import { describe, expect, it } from 'vitest';
import type { AnalyticsConfig } from 'analytics-kit';
import { createFernlyAnalytics } from './harness';
import { fernlyTaxonomy } from './taxonomy';

const crossSubdomainConfig: AnalyticsConfig & { taxonomy: typeof fernlyTaxonomy } = {
  key: 'k',
  taxonomy: fernlyTaxonomy,
  cookieDomain: '.fernly.example',
  crossSubdomainCookie: true,
};

describe('Fernly cross-subdomain merge + reset at the neutral seam', () => {
  it('accepts cookieDomain + crossSubdomainCookie via config only and constructs the harness', () => {
    const { analytics, recorder } = createFernlyAnalytics(crossSubdomainConfig);

    // Config-only surface acceptance (bar B): the harness constructs and records a track
    // under the cross-subdomain config with zero library change.
    analytics.track('signup_started');

    expect(recorder.captures).toHaveLength(1);
    expect(recorder.captures[0]!.event).toBe('signup_started');
  });

  it('preserves the distinct id across a staged marketing -> app handoff (anon links to the identified id)', () => {
    // ONE root harness = one shared recording adapter (the way one .fernly.example cookie
    // is shared). The two "phases" are staged call sequences on the same instance, NOT
    // context() scoped views.
    const { analytics, recorder } = createFernlyAnalytics(crossSubdomainConfig);

    // marketing phase (fernly.example): anonymous events before identify.
    const anonymousId = recorder.getDistinctId();
    analytics.track('signup_started');
    analytics.track('document_uploaded', { documentId: 'doc-1', sizeBytes: 4096 });

    // app phase (app.fernly.example): the reviewer identifies — anon id merges into it.
    analytics.identify('reviewer-42', { role: 'reviewer', plan: 'pro' });
    analytics.track('signup_completed', { plan: 'pro' });

    // The merge link: the anonymous id is retained as the link to the identified id.
    expect(recorder.merges).toEqual([{ anonymousId, identifiedId: 'reviewer-42' }]);

    // The identified id is now the current distinct id — preserved across the handoff.
    expect(recorder.getDistinctId()).toBe('reviewer-42');

    // The neutral stream: anon events carry the anon id, post-identify events the
    // identified id — one identity threaded across the two subdomains.
    expect(recorder.captures.map((c) => c.event)).toEqual([
      'signup_started',
      'document_uploaded',
      'signup_completed',
    ]);
    expect(recorder.captures.map((c) => c.distinctId)).toEqual([
      anonymousId,
      anonymousId,
      'reviewer-42',
    ]);
  });

  it('carries the anon id on events captured before identify', () => {
    const { analytics, recorder } = createFernlyAnalytics(crossSubdomainConfig);
    const anonymousId = recorder.getDistinctId();

    analytics.track('signup_started');
    analytics.track('document_uploaded', { documentId: 'doc-1', sizeBytes: 4096 });

    expect(recorder.merges).toHaveLength(0);
    expect(recorder.captures.map((c) => c.distinctId)).toEqual([anonymousId, anonymousId]);
  });

  it('reset() clears identity and re-anonymizes — a fresh anon id is minted and the link dropped', () => {
    const { analytics, recorder } = createFernlyAnalytics(crossSubdomainConfig);

    const anonymousId = recorder.getDistinctId();
    analytics.identify('reviewer-42', { role: 'reviewer' });
    expect(recorder.getDistinctId()).toBe('reviewer-42');
    expect(recorder.merges).toEqual([{ anonymousId, identifiedId: 'reviewer-42' }]);

    analytics.reset();

    // Identity cleared: a fresh anon id, distinct from both the prior anon and identified ids.
    const resetAnonymousId = recorder.getDistinctId();
    expect(recorder.resets).toEqual([{}]);
    expect(resetAnonymousId).not.toBe('reviewer-42');
    expect(resetAnonymousId).not.toBe(anonymousId);

    // Post-reset events carry the fresh anon id — re-anonymized on the stream.
    analytics.track('signup_started');
    expect(recorder.captures.at(-1)!.distinctId).toBe(resetAnonymousId);
  });

  it('re-anonymizes so a subsequent identify merges from the NEW anon id, not the old one', () => {
    const { analytics, recorder } = createFernlyAnalytics(crossSubdomainConfig);

    const firstAnonymousId = recorder.getDistinctId();
    analytics.identify('reviewer-42');
    expect(recorder.merges).toEqual([{ anonymousId: firstAnonymousId, identifiedId: 'reviewer-42' }]);

    analytics.reset();
    const secondAnonymousId = recorder.getDistinctId();

    // A second login identifies a different reviewer — the merge links the FRESH anon id
    // (post-reset), never the retained pre-reset link.
    analytics.identify('reviewer-99');

    expect(recorder.merges).toEqual([
      { anonymousId: firstAnonymousId, identifiedId: 'reviewer-42' },
      { anonymousId: secondAnonymousId, identifiedId: 'reviewer-99' },
    ]);
    expect(recorder.getDistinctId()).toBe('reviewer-99');
  });
});
