import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { AnalyticsClientProvider, useFeatureFlags } from '@randomtoni/analytics-kit-react';
import { createAnalytics } from '@randomtoni/analytics-kit-browser';
import type { ReactNode } from 'react';
import { createFernlyFlagClient, type FernlyFlagShape } from '../flag-harness';
import { AiSummaryBadge } from './fernly-app';

// E12-S6 — Fernly React flag proof. Mounts the real useFeatureFlags hook (S5) under an
// AnalyticsClientProvider whose client's `flags` slot is the REAL browser FlagClient (bootstrap
// seeded + a deterministic deferred fetch). Proves: the first synchronous paint is the empty
// snapshot (async-only port), then the hook re-renders as the bootstrap set — and again as the
// network set arrives via onChange. No socket; the flag fetch is stubbed.

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  globalThis.fetch = originalFetch;
});

function Mounted({ children }: { children: ReactNode }): ReactNode {
  return <>{children}</>;
}

describe('Fernly React — useFeatureFlags re-renders as flags arrive', () => {
  it('first paint shows the empty default, then the bootstrap variant, then the network variant', async () => {
    const handle = createFernlyFlagClient(originalFetch, (stub) => vi.stubGlobal('fetch', stub));

    render(
      <AnalyticsClientProvider client={handle.analytics}>
        <Mounted>
          <AiSummaryBadge />
        </Mounted>
      </AnalyticsClientProvider>
    );

    // First synchronous render: the async-only port has nothing resolved yet, so the hook's
    // initial state is emptyFlagSet() and the badge reads its 'control' default.
    expect(screen.getByTestId('ai-summary-variant').textContent).toBe('control');

    // The effect runs evaluate() (serves bootstrap synchronously off cache) and subscribes to
    // onChange; the bootstrap variant lands on the next microtask.
    await waitFor(() => {
      expect(screen.getByTestId('ai-summary-variant').textContent).toBe('concise');
    });

    // The background fetch resolves → onChange re-fires with the network set → re-render.
    handle.resolveFetch();
    await waitFor(() => {
      expect(screen.getByTestId('ai-summary-variant').textContent).toBe('detailed');
    });
  });

  it('a client with no flags slot renders the empty default and never throws (bar B graceful)', () => {
    // A REAL unkeyed browser client: createAnalytics({}) resolves the NoopAdapter, so provider.flags
    // is genuinely undefined (not a hand-stubbed slot). The hook falls back to the seam empty
    // snapshot, so the component renders flags-off with no crash — the bar-B proof end-to-end.
    function Bare(): ReactNode {
      const flags = useFeatureFlags<FernlyFlagShape>();
      return <span data-testid="bare">{String(flags.isEnabled('bulk_review_actions'))}</span>;
    }
    const noFlagsClient = createAnalytics({});
    expect(noFlagsClient.flags).toBeUndefined();
    expect(() =>
      render(
        <AnalyticsClientProvider client={noFlagsClient}>
          <Bare />
        </AnalyticsClientProvider>
      )
    ).not.toThrow();
    expect(screen.getByTestId('bare').textContent).toBe('false');
  });
});
