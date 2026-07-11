import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createAnalytics } from '@randomtoni/analytics-kit-browser';
import type { AnalyticsConfig, RootAnalytics } from '@randomtoni/analytics-kit-browser';
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
  const pendingShutdown = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    // StrictMode's dev unmount→remount is synchronous within a tick; deferring shutdown
    // lets the immediately-following remount cancel it, so the client's DOM listeners stay
    // attached in dev. A real unmount has no remount to cancel it, so the shutdown fires.
    if (pendingShutdown.current !== undefined) {
      clearTimeout(pendingShutdown.current);
      pendingShutdown.current = undefined;
    }
    // Under SSR (renderToString) effects never run, so this owned client is never shutdown()-drained here — it's GC'd, harmless (no transport/DOM work happens before an effect commits).
    return () => {
      pendingShutdown.current = setTimeout(() => {
        void client.shutdown();
      }, 0);
    };
  }, [client]);

  return (
    <AnalyticsClientContext.Provider value={client}>{children}</AnalyticsClientContext.Provider>
  );
}
