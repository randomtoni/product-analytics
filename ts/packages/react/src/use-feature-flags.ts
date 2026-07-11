import { useContext, useEffect, useMemo, useState } from 'react';
import { emptyFlagSet } from '@randomtoni/analytics-kit';
import type {
  DefaultTaxonomyShape,
  FeatureFlagPort,
  FlagSet,
  RootAnalytics,
  TaxonomyShape,
} from '@randomtoni/analytics-kit';
import { AnalyticsClientContext, NOT_IN_PROVIDER } from './analytics-client-context';

export function useFeatureFlags<
  TX extends TaxonomyShape = DefaultTaxonomyShape,
>(): FlagSet<TX> {
  const client = useContext(AnalyticsClientContext);
  if (client === NOT_IN_PROVIDER) {
    throw new Error(
      'useFeatureFlags() must be used within an <AnalyticsClientProvider>.'
    );
  }
  const flags = (client as RootAnalytics<TX>).flags as FeatureFlagPort<TX> | undefined;

  // Initial paint shows the canonical empty/degraded snapshot: the port's only current-value
  // read is the async evaluate(), so a synchronous first render (server and client alike)
  // cannot show the bootstrap set. This deterministic initializer also keeps SSR and the
  // client's first commit in lockstep — no hydration mismatch — before the effect promotes it.
  const [set, setSet] = useState<FlagSet<TX>>(() => emptyFlagSet<TX>());
  const empty = useMemo(() => emptyFlagSet<TX>(), []);

  useEffect(() => {
    if (flags === undefined) {
      return;
    }
    // Subscribe first, then seed. A committed onChange set is always the freshest value, so a
    // late-resolving evaluate() must not overwrite one that already landed; `changed` records
    // that an onChange won the race. `cancelled` stops any setState after a StrictMode-orphaned
    // unmount, whichever settles first.
    let cancelled = false;
    let changed = false;
    const unsubscribe = flags.onChange((next) => {
      if (cancelled) {
        return;
      }
      changed = true;
      setSet(next);
    });
    void flags.evaluate().then((initial) => {
      if (!cancelled && !changed) {
        setSet(initial);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [flags]);

  return flags === undefined ? empty : set;
}
