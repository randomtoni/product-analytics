import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { AnalyticsClientProvider, useAnalytics } from '@analytics-kit/react';
import { createAnalytics } from '@analytics-kit/browser';
import type { ReactNode } from 'react';
import { createFernlyReplayClient } from '../replay-harness';

// E14-S5 — Fernly React replay proof. Mounts a component under an AnalyticsClientProvider whose
// client's `replay` slot is the REAL browser ReplayRecorder (enabled config-only). Proves replay
// control is reachable through the React binding via the provider slot (useAnalytics().replay) —
// the way useFeatureFlags reaches provider.flags — taxonomy-agnostic (replay carries no props
// taxonomy, so it rides the root client slot, not a dedicated typed hook). No socket, no rrweb
// assertion — the neutral port reads (isActive/getReplayId) are what a consumer touches.

// A replay-control widget: reads provider.replay off the root client and exposes its state. This is
// the consumer's React-side seat for replay — reached through the neutral provider slot only.
function ReplayControls(): ReactNode {
  const analytics = useAnalytics();
  const replay = analytics.replay;
  return (
    <div>
      <span data-testid="replay-present">{String(replay !== undefined)}</span>
      <span data-testid="replay-active">{String(replay?.isActive() ?? false)}</span>
      <button type="button" data-testid="start-replay" onClick={() => replay?.start()}>
        Start replay
      </button>
    </div>
  );
}

afterEach(() => {
  cleanup();
});

describe('Fernly React — replay control reachable via the provider slot', () => {
  it('a replay-enabled client exposes provider.replay through the React binding', () => {
    const analytics = createFernlyReplayClient();

    render(
      <AnalyticsClientProvider client={analytics}>
        <ReplayControls />
      </AnalyticsClientProvider>
    );

    // The provider slot is reachable from a component via useAnalytics().replay — the neutral seat.
    expect(screen.getByTestId('replay-present').textContent).toBe('true');
    expect(screen.getByTestId('replay-active').textContent).toBe('false');
  });

  it('a client with no replay slot renders replay-off and never throws (bar B graceful)', () => {
    // A REAL unkeyed browser client: createAnalytics({}) resolves the NoopAdapter, so provider.replay
    // is genuinely undefined. The component reads replay-off with no crash — the bar-B posture,
    // end-to-end through the React binding.
    const noReplayClient = createAnalytics({});
    expect(noReplayClient.replay).toBeUndefined();

    expect(() =>
      render(
        <AnalyticsClientProvider client={noReplayClient}>
          <ReplayControls />
        </AnalyticsClientProvider>
      )
    ).not.toThrow();
    expect(screen.getByTestId('replay-present').textContent).toBe('false');
    expect(screen.getByTestId('replay-active').textContent).toBe('false');
  });
});
