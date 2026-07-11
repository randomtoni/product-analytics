import { useState } from 'react';
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { RootAnalytics, ShapeOf } from '@randomtoni/analytics-kit';
import { createFernlyAnalytics } from '../harness';
import { type FernlyTaxonomy } from '../taxonomy';
import { FernlyAppViaClient, FernlyAppViaConfig, ReviewWorkspace, fernlyConfig } from './fernly-app';

type FernlyShape = ShapeOf<FernlyTaxonomy['decl']>;

afterEach(cleanup);

function RoutedApp({ client }: { client: RootAnalytics<FernlyShape> }) {
  const [route, setRoute] = useState('/dashboard');
  return (
    <>
      <FernlyAppViaClient client={client} route={route} />
      <button type="button" onClick={() => setRoute('/documents/doc-1')}>
        Navigate
      </button>
    </>
  );
}

describe('Fernly React binding — wired against the seam+mock (client-branch)', () => {
  test('provider mounts and useAnalytics resolves the injected client → page() fires on mount', () => {
    const { analytics, recorder } = createFernlyAnalytics({ key: 'fernly-test-key' });

    render(<FernlyAppViaClient client={analytics} route="/dashboard" />);

    expect(screen.getByText('Request review')).toBeDefined();
    const pageCaptures = recorder.captures.filter((c) => c.event === 'page');
    expect(pageCaptures).toHaveLength(1);
  });

  test('a simulated route change drives another page() into the recording adapter', () => {
    const { analytics, recorder } = createFernlyAnalytics({ key: 'fernly-test-key' });

    render(<RoutedApp client={analytics} />);
    expect(recorder.captures.filter((c) => c.event === 'page')).toHaveLength(1);

    act(() => {
      fireEvent.click(screen.getByText('Navigate'));
    });

    expect(recorder.captures.filter((c) => c.event === 'page')).toHaveLength(2);
  });

  test('a component track lands a taxonomy-typed event on the stream', () => {
    const { analytics, recorder } = createFernlyAnalytics({ key: 'fernly-test-key' });

    render(<FernlyAppViaClient client={analytics} route="/dashboard" />);

    act(() => {
      fireEvent.click(screen.getByText('Request review'));
    });

    const tracked = recorder.captures.filter((c) => c.event === 'review_requested');
    expect(tracked).toHaveLength(1);
    expect(tracked[0]!.properties).toMatchObject({ documentId: 'doc-1', reviewerId: 'reviewer-7' });
  });

  test('the same route value threaded twice does NOT re-fire page() (no history listener)', () => {
    const { analytics, recorder } = createFernlyAnalytics({ key: 'fernly-test-key' });

    const { rerender } = render(<FernlyAppViaClient client={analytics} route="/dashboard" />);
    expect(recorder.captures.filter((c) => c.event === 'page')).toHaveLength(1);

    rerender(<FernlyAppViaClient client={analytics} route="/dashboard" />);
    window.history.pushState({}, '', '/deep/link');
    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(recorder.captures.filter((c) => c.event === 'page')).toHaveLength(1);
  });
});

describe('Fernly React binding — config-branch is a whole-stack no-op (bar B)', () => {
  test('an unkeyed config-branch app mounts and never throws (no injected recorder)', () => {
    expect(() => render(<FernlyAppViaConfig />)).not.toThrow();
    expect(screen.getByText('Request review')).toBeDefined();
  });
});

test('fernlyConfig is typecheck-honest and carries no key (unkeyed no-op if run)', () => {
  expect(fernlyConfig.key).toBeUndefined();
  expect(fernlyConfig.cookieDomain).toBe('.fernly.example');
});

// Type-level only: never invoked (would throw the no-provider error at runtime).
// Exists so `tsc` checks that useAnalytics<FernlyShape>() is taxonomy-typed and a
// wrong event name / wrong prop type is a COMPILE error, not a runtime surprise.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _componentTrackIsTaxonomyTyped() {
  const analytics = useAnalyticsForTypeCheck();

  analytics.track('review_requested', { documentId: 'doc-1', reviewerId: 'reviewer-7' });
  analytics.track('signup_started');

  // @ts-expect-error — 'checkout_started' is not a declared Fernly event
  analytics.track('checkout_started', {});

  // @ts-expect-error — 'reviewerId' must be a string per the declared taxonomy
  analytics.track('review_requested', { documentId: 'doc-1', reviewerId: 42 });
}

// Isolated so the @ts-expect-error above targets the taxonomy, not the hook rules.
declare function useAnalyticsForTypeCheck(): RootAnalytics<FernlyShape>;

test('the routed component renders under jsdom (ties the type-check block to a live mount)', () => {
  const { analytics } = createFernlyAnalytics({ key: 'fernly-test-key' });
  render(<FernlyAppViaClient client={analytics} route="/dashboard" />);
  expect(screen.getByRole('button', { name: 'Request review' })).toBeDefined();
  // ReviewWorkspace is the component whose useAnalytics<FernlyShape>().track is type-checked above.
  expect(typeof ReviewWorkspace).toBe('function');
});
