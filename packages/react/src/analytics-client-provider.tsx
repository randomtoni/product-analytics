import { useEffect, useState, type ReactNode } from 'react';
import { createAnalytics } from '@analytics-kit/browser';
import type { AnalyticsConfig, RootAnalytics } from '@analytics-kit/browser';
import { AnalyticsClientContext } from './analytics-client-context';

export type AnalyticsClientProviderProps = { children?: ReactNode } & (
  | { client: RootAnalytics; config?: never }
  | { config: AnalyticsConfig; client?: never }
);

export function AnalyticsClientProvider(props: AnalyticsClientProviderProps): ReactNode {
  const { children, client: passedClient, config } = props;

  if (passedClient !== undefined && config !== undefined) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        'AnalyticsClientProvider received both `client` and `config`. `config` is ignored in favour of `client`.'
      );
    }
  }

  const [ownedClient] = useState<RootAnalytics | undefined>(() =>
    passedClient === undefined ? createAnalytics(config as AnalyticsConfig) : undefined
  );

  const client = passedClient ?? (ownedClient as RootAnalytics);

  useEffect(() => {
    if (ownedClient === undefined) {
      return;
    }
    return () => {
      void ownedClient.shutdown();
    };
  }, [ownedClient]);

  return (
    <AnalyticsClientContext.Provider value={client}>{children}</AnalyticsClientContext.Provider>
  );
}
