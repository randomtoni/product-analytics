import { createAnalytics, NoopAdapter } from 'analytics-kit';
import type { AnalyticsConfig, RootAnalytics } from 'analytics-kit';
import { RecordingAdapter } from './recording-adapter';

export interface FernlyHarness {
  analytics: RootAnalytics;
  recorder: RecordingAdapter;
}

export function createFernlyAnalytics(config: AnalyticsConfig = {}): FernlyHarness {
  const recorder = new RecordingAdapter();
  const adapter = config.key === undefined ? new NoopAdapter() : recorder;
  const analytics = createAnalytics(config, adapter, {
    generateUuid: () => crypto.randomUUID(),
  });
  return { analytics, recorder };
}
