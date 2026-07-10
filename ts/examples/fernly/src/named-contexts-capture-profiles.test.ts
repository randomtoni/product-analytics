import { describe, expect, it } from 'vitest';
import type { AnalyticsConfig, EnrichmentProfile } from 'analytics-kit';
import { createFernlyAnalytics } from './harness';
import { fernlyTaxonomy } from './taxonomy';

// Two named contexts sharing one identity/session/transport. Each carries a DISTINCT
// enrichment block — the per-event stream difference is driven ENTIRELY by `enrichment`,
// not by `autocapture` (a construction-time toggle resolved once from defaultContext).
const contextsConfig: AnalyticsConfig & { taxonomy: typeof fernlyTaxonomy } = {
  key: 'k',
  taxonomy: fernlyTaxonomy,
  defaultContext: 'marketing',
  contexts: {
    marketing: {
      autocapture: true,
      enrichment: { page: true, utm: true },
    },
    app: {
      autocapture: false,
      enrichment: { page: false, utm: false },
    },
  },
};

const marketingProfile: EnrichmentProfile = { page: true, utm: true };
const appProfile: EnrichmentProfile = { page: false, utm: false };

describe('Fernly named contexts + capture profiles at the neutral seam', () => {
  it('accepts contexts + defaultContext via config only and constructs the harness', () => {
    const { analytics, recorder } = createFernlyAnalytics(contextsConfig);

    // Config-only surface acceptance (bar B): the harness constructs and both scoped
    // views record, with zero library change.
    analytics.context('marketing').track('signup_started');
    analytics.context('app').track('document_uploaded', { documentId: 'doc-1', sizeBytes: 4096 });

    expect(recorder.captures).toHaveLength(2);
    expect(recorder.captures.map((c) => c.event)).toEqual([
      'signup_started',
      'document_uploaded',
    ]);
  });

  it('stamps the SAME distinct id from both contexts — shared identity/session/transport', () => {
    const { analytics, recorder } = createFernlyAnalytics(contextsConfig);

    const marketing = analytics.context('marketing');
    const app = analytics.context('app');

    // The shared distinct id before any capture: both scoped views delegate identity to
    // the same root core, so neither mints its own.
    const sharedId = recorder.getDistinctId();

    marketing.track('signup_started');
    app.track('document_uploaded', { documentId: 'doc-1', sizeBytes: 4096 });
    marketing.page('home', { path: '/', referrer: '' });
    app.page('review', { path: '/review/doc-1', referrer: '' });

    // Every event across BOTH contexts carries the one shared distinct id — the
    // cross-context funnel-stitching proof.
    const distinctIds = recorder.captures.map((c) => c.distinctId);
    expect(new Set(distinctIds).size).toBe(1);
    expect(distinctIds).toEqual([sharedId, sharedId, sharedId, sharedId]);
  });

  it('shares the distinct id even after an identify made through the root core', () => {
    const { analytics, recorder } = createFernlyAnalytics(contextsConfig);

    // Identity is a root-only verb (the scoped view exposes no identify). A reviewer
    // identifies on the shared core; subsequent captures from either context carry it.
    analytics.identify('reviewer-42', { role: 'reviewer', plan: 'pro' });

    analytics.context('marketing').track('signup_completed', { plan: 'pro' });
    analytics.context('app').track('review_completed', { documentId: 'doc-1', approved: true });

    expect(recorder.captures.map((c) => c.distinctId)).toEqual([
      'reviewer-42',
      'reviewer-42',
    ]);
  });

  it('rides the per-context enrichment profile on the minted event — and it DIFFERS per context', () => {
    const { analytics, recorder } = createFernlyAnalytics(contextsConfig);

    analytics.context('marketing').track('signup_started');
    analytics.context('app').track('document_uploaded', { documentId: 'doc-1', sizeBytes: 4096 });

    const [marketingEvent, appEvent] = recorder.captures;

    // Each context's resolved EnrichmentProfile rides its minted NeutralEvent.
    expect(marketingEvent!.enrichmentProfile).toEqual(marketingProfile);
    expect(appEvent!.enrichmentProfile).toEqual(appProfile);

    // The difference is the point: marketing enriches page + utm, app suppresses both.
    expect(marketingEvent!.enrichmentProfile).not.toEqual(appEvent!.enrichmentProfile);
  });

  it('rides the per-context enrichment profile on page() events too', () => {
    const { analytics, recorder } = createFernlyAnalytics(contextsConfig);

    analytics.context('marketing').page('home', { path: '/', referrer: '' });
    analytics.context('app').page('review', { path: '/review/doc-1', referrer: '' });

    const [marketingPage, appPage] = recorder.captures;

    expect(marketingPage!.isPageView).toBe(true);
    expect(appPage!.isPageView).toBe(true);
    expect(marketingPage!.enrichmentProfile).toEqual(marketingProfile);
    expect(appPage!.enrichmentProfile).toEqual(appProfile);
    expect(marketingPage!.enrichmentProfile).not.toEqual(appPage!.enrichmentProfile);
  });

  it('leaves root captures without an enrichment profile — the profile is a context-scoped override', () => {
    // Regression pin: a root-level track carries NO enrichmentProfile (the adapter falls
    // back to its own instance-level enrichment). Only scoped context captures stamp it.
    const { analytics, recorder } = createFernlyAnalytics(contextsConfig);

    analytics.track('signup_started');

    expect(recorder.captures[0]!.enrichmentProfile).toBeUndefined();
  });

  it('yields no enrichment override for a context whose profile omits enrichment', () => {
    // Edge: a named context with an absent enrichment block resolves to undefined — so
    // its scoped captures behave like root captures (no per-event override). This is the
    // exact reason each real context above carries a distinct, non-absent enrichment block.
    const { analytics, recorder } = createFernlyAnalytics({
      key: 'k',
      taxonomy: fernlyTaxonomy,
      defaultContext: 'bare',
      contexts: {
        bare: { autocapture: true },
      },
    });

    analytics.context('bare').track('signup_started');

    expect(recorder.captures[0]!.enrichmentProfile).toBeUndefined();
  });
});
