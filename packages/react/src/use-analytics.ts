import { useContext } from 'react';
import type { DefaultTaxonomyShape, RootAnalytics, TaxonomyShape } from 'analytics-kit';
import { AnalyticsClientContext, NOT_IN_PROVIDER } from './analytics-client-context';

export function useAnalytics<
  TX extends TaxonomyShape = DefaultTaxonomyShape,
>(): RootAnalytics<TX> {
  const client = useContext(AnalyticsClientContext);
  if (client === NOT_IN_PROVIDER) {
    throw new Error(
      'useAnalytics() must be used within an <AnalyticsClientProvider>. No provider was found above this component.'
    );
  }
  return client as RootAnalytics<TX>;
}
