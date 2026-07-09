import { useEffect, useRef } from 'react';
import type { DefaultTaxonomyShape, TaxonomyShape } from 'analytics-kit';
import { useAnalytics } from './use-analytics';

export interface UsePageViewOptions<TX extends TaxonomyShape = DefaultTaxonomyShape> {
  name?: string;
  props?: TX['page'];
  captureOnMount?: boolean;
}

export function usePageView<TX extends TaxonomyShape = DefaultTaxonomyShape>(
  routeKey: string | undefined,
  options?: UsePageViewOptions<TX>
): void {
  const analytics = useAnalytics<TX>();
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      if (options?.captureOnMount === false) {
        return;
      }
    }
    analytics.page(options?.name, options?.props);
  }, [routeKey]);
}
