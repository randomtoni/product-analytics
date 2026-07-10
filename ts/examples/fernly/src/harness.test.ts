import { describe, expect, it } from 'vitest';
import { createFernlyAnalytics } from './harness';

describe('createFernlyAnalytics no-op / recording proof', () => {
  it('unkeyed harness records nothing on track (bar-B whole-stack no-op)', () => {
    const { analytics, recorder } = createFernlyAnalytics();

    analytics.track('signup_started');

    expect(recorder.captures).toHaveLength(0);
  });

  it('keyed harness (key + granting consent) records a track — recording path is live', () => {
    const { analytics, recorder } = createFernlyAnalytics({ key: 'fernly-test-key' });

    analytics.track('signup_started');

    expect(recorder.captures).toHaveLength(1);
    expect(recorder.captures[0]!.event).toBe('signup_started');
  });

  it('keyed harness mints a dedupeId per event (generateUuid is threaded)', () => {
    const { analytics, recorder } = createFernlyAnalytics({ key: 'fernly-test-key' });

    analytics.track('signup_started');

    expect(recorder.captures[0]!.dedupeId).toBeTruthy();
  });
});
