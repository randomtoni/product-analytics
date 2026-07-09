import { useEffect, useRef } from 'react';
import type { DefaultTaxonomyShape, TaxonomyShape } from 'analytics-kit';
import { useAnalytics } from './use-analytics';

export interface UsePageViewOptions<TX extends TaxonomyShape = DefaultTaxonomyShape> {
  name?: string;
  props?: TX['page'];
  captureOnMount?: boolean;
}

// A sentinel distinct from every possible routeKey (any string OR undefined), so the very
// first effect run always registers as a change to fire — never a false "already fired".
const NEVER_FIRED = Symbol('never-fired');

export function usePageView<TX extends TaxonomyShape = DefaultTaxonomyShape>(
  routeKey: string | undefined,
  options?: UsePageViewOptions<TX>
): void {
  const analytics = useAnalytics<TX>();
  // The last routeKey a page() was ACTUALLY fired for. Refs persist across StrictMode's
  // dev mount→unmount→remount, so keying the fire on this makes it idempotent: a repeated
  // effect run with an unchanged routeKey (the StrictMode double-invoke) fires nothing.
  const lastFired = useRef<string | undefined | typeof NEVER_FIRED>(NEVER_FIRED);

  useEffect(() => {
    if (routeKey === lastFired.current) {
      return;
    }
    // captureOnMount:false on the FIRST-ever run records the mount routeKey as already-fired
    // WITHOUT firing — so neither the mount nor a StrictMode re-run fires, yet a later real
    // route change still does. Subsequent runs fall through to the normal fire path.
    if (lastFired.current === NEVER_FIRED && options?.captureOnMount === false) {
      lastFired.current = routeKey;
      return;
    }
    lastFired.current = routeKey;
    analytics.page(options?.name, options?.props);
  }, [routeKey]);
}
