import { describe, expect, it } from 'vitest';
import { NoopAdapter } from 'analytics-kit';
import type { AnalyticsAdapter, RootAnalytics } from 'analytics-kit';
import { createFernlyAnalytics } from './harness';
import { RecordingAdapter } from './recording-adapter';

// Bar A — provider-swap = ONE adapter, ZERO consumer change.
//
// The E10 harness already selects the backend adapter by config through the SAME
// `createAnalytics(config, adapter, deps)` seam (`config.key === undefined ? NoopAdapter
// : RecordingAdapter`). This suite ASSERTS that swap as the bar-A proof: the consumer
// call site (`createFernlyAnalytics(config)`) is byte-identical across both adapters,
// both satisfy the `AnalyticsAdapter` SPI, the returned facade shape is identical, and
// the same sequence of neutral facade calls behaves consistently regardless of backend.

// The 18-member `AnalyticsAdapter` SPI a new client adapter must satisfy — the finite,
// fill-in-the-blanks surface. Verified against `packages/analytics-kit/src/adapter.ts`.
const ANALYTICS_ADAPTER_SPI: readonly (keyof AnalyticsAdapter)[] = [
  'capture',
  'identify',
  'register',
  'unregister',
  'reset',
  'getDistinctId',
  'group',
  'alias',
  'flush',
  'shutdown',
  'getConsentState',
  'setConsentState',
  'fetch',
  'getPersistedProperty',
  'setPersistedProperty',
  'getLibraryId',
  'getLibraryVersion',
  'getCustomUserAgent',
];

function isStructuralAdapter(candidate: object): boolean {
  return ANALYTICS_ADAPTER_SPI.every(
    (member) => typeof (candidate as Record<string, unknown>)[member] === 'function'
  );
}

// The facade's public keys — sorted for a stable, order-independent comparison. This is
// the consumer-observable shape; it MUST be identical across the swap.
function facadeKeys(analytics: RootAnalytics): string[] {
  const bag = analytics as unknown as Record<string, unknown>;
  const keys = new Set<string>();
  let proto: object | null = analytics;
  while (proto !== null && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key !== 'constructor' && !key.startsWith('_') && typeof bag[key] === 'function') {
        keys.add(key);
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
  return [...keys].sort();
}

describe('bar A — provider-swap = one adapter, zero consumer change', () => {
  it('both adapters satisfy the 18-member AnalyticsAdapter SPI (structurally)', () => {
    expect(ANALYTICS_ADAPTER_SPI).toHaveLength(18);
    expect(isStructuralAdapter(new NoopAdapter())).toBe(true);
    expect(isStructuralAdapter(new RecordingAdapter())).toBe(true);
  });

  it('the SAME consumer call site flows both adapters through ONE createAnalytics seam', () => {
    // The unkeyed call selects NoopAdapter, the keyed call selects RecordingAdapter —
    // both through the identical `createFernlyAnalytics(config)` → `createAnalytics(
    // config, adapter, deps)` seam. The consumer writes ONE call site, not two.
    const noopBacked = createFernlyAnalytics();
    const recordingBacked = createFernlyAnalytics({ key: 'fernly-test-key' });

    expect(recordingBacked.recorder).toBeInstanceOf(RecordingAdapter);
    // Both produced a live RootAnalytics facade from the same factory.
    expect(typeof noopBacked.analytics.track).toBe('function');
    expect(typeof recordingBacked.analytics.track).toBe('function');
  });

  it('the returned facade keyof is byte-identical across the swap', () => {
    const noopBacked = createFernlyAnalytics();
    const recordingBacked = createFernlyAnalytics({ key: 'fernly-test-key' });

    const noopKeys = facadeKeys(noopBacked.analytics);
    const recordingKeys = facadeKeys(recordingBacked.analytics);

    // The consumer-facing surface does not change when the backend adapter changes.
    expect(noopKeys).toEqual(recordingKeys);
    // Sanity: the frozen root verbs are present on that shared surface.
    for (const verb of ['track', 'identify', 'page', 'group', 'reset', 'flush', 'shutdown', 'context']) {
      expect(noopKeys).toContain(verb);
    }
  });

  it('the SAME neutral call sequence runs identically against either backend (zero consumer edits)', () => {
    // Byte-for-byte the SAME consumer code, run twice — once per backend. The only
    // difference is which adapter the seam selected; the calling code never changes.
    const drive = (analytics: RootAnalytics): void => {
      analytics.identify('user-42', { plan: 'pro' });
      analytics.track('signup_started');
      analytics.group('company', 'acme');
      analytics.register({ tenant: 'acme' });
      analytics.page('home');
      analytics.reset();
    };

    const noopBacked = createFernlyAnalytics();
    const recordingBacked = createFernlyAnalytics({ key: 'fernly-test-key' });

    // No throw, no divergence in the consumer's own code path across the swap.
    expect(() => drive(noopBacked.analytics)).not.toThrow();
    expect(() => drive(recordingBacked.analytics)).not.toThrow();

    // The behavioral difference lives ENTIRELY behind the seam: the no-op backend
    // records nothing; the recording backend captured the same driven event stream.
    expect(recordingBacked.recorder.captures.map((c) => c.event)).toContain('signup_started');
    expect(recordingBacked.recorder.identifies.map((i) => i.distinctId)).toContain('user-42');
  });
});
