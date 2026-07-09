import { useState, type ReactNode } from 'react';
import { AnalyticsClientProvider, useAnalytics, usePageView } from '@analytics-kit/react';
import type { AnalyticsConfig, RootAnalytics } from '@analytics-kit/browser';
import type { ShapeOf } from 'analytics-kit';
import { fernlyTaxonomy, type FernlyTaxonomy } from '../taxonomy';

type FernlyShape = ShapeOf<FernlyTaxonomy['decl']>;

export const fernlyConfig: AnalyticsConfig = {
  cookieDomain: '.fernly.example',
  defaultContext: 'app',
  contexts: {
    marketing: { autocapture: true, enrichment: { page: true, utm: true } },
    app: { autocapture: false, enrichment: { page: false, utm: false } },
  },
  taxonomy: fernlyTaxonomy,
};

export function ReviewWorkspace({ route }: { route: string }): ReactNode {
  const analytics = useAnalytics<FernlyShape>();

  // Route-source contract: a real Fernly app threads the framework's own route
  // value into usePageView — Next app-router `const route = usePathname()`,
  // Next pages `const route = router.asPath`, React Router
  // `const route = useLocation().pathname`. The binding holds no history
  // listener; it fires page() whenever this threaded value changes. The slice
  // stays framework-neutral by threading a plain value (on-brief: router-driven,
  // not Next-router-driven).
  usePageView<FernlyShape>(route, { props: { path: route, referrer: '' } });

  function onRequestReview(documentId: string, reviewerId: string): void {
    analytics.track('review_requested', { documentId, reviewerId });
  }

  return (
    <button type="button" onClick={() => onRequestReview('doc-1', 'reviewer-7')}>
      Request review
    </button>
  );
}

// Config-branch: the zero-boilerplate adoption path. The provider constructs its
// own client from config internally (browser createAnalytics → a real
// BrowserAdapter/NoopAdapter), so this is the shape a real app ships. An unkeyed
// config would be a whole-stack no-op; fernlyConfig here is typecheck-honest.
export function FernlyAppViaConfig(): ReactNode {
  const [route, setRoute] = useState('/dashboard');
  return (
    <AnalyticsClientProvider config={fernlyConfig}>
      <ReviewWorkspace route={route} />
      <button type="button" onClick={() => setRoute('/documents/doc-1')}>
        Open document
      </button>
    </AnalyticsClientProvider>
  );
}

// Client-branch: an already-constructed RootAnalytics (e.g. the seam+mock harness
// from S1) is injected. A RootAnalytics<FernlyShape> widens cleanly to the
// provider's default-shape `client: RootAnalytics` prop.
export function FernlyAppViaClient({
  client,
  route,
}: {
  client: RootAnalytics<FernlyShape>;
  route: string;
}): ReactNode {
  return (
    <AnalyticsClientProvider client={client}>
      <ReviewWorkspace route={route} />
    </AnalyticsClientProvider>
  );
}
