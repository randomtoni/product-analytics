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

  if (passedClient !== undefined) {
    return (
      <AnalyticsClientContext.Provider value={passedClient}>
        {children}
      </AnalyticsClientContext.Provider>
    );
  }

  return <OwnedAnalyticsProvider config={config}>{children}</OwnedAnalyticsProvider>;
}

function OwnedAnalyticsProvider({
  config,
  children,
}: {
  config: AnalyticsConfig;
  children?: ReactNode;
}): ReactNode {
  const [client] = useState<RootAnalytics>(() => createAnalytics(config));

  useEffect(() => {
    // Under SSR (renderToString) effects never run, so this owned client is never shutdown()-drained here — it's GC'd, harmless (no transport/DOM work happens before an effect commits).
    return () => {
      void client.shutdown();
    };
  }, [client]);

  return (
    <AnalyticsClientContext.Provider value={client}>{children}</AnalyticsClientContext.Provider>
  );
}
