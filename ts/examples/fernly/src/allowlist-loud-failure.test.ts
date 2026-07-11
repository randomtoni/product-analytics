import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveAllowlistFromTaxonomy } from '@randomtoni/analytics-kit';
import type { AnalyticsConfig } from '@randomtoni/analytics-kit';
import { createFernlyAnalytics } from './harness';
import { fernlyTaxonomy } from './taxonomy';

// Fernly's privacy POLICY, config-only: the exhaustive set of prop/trait keys permitted
// to leave the app. Enforcement is the library's; this list is all the consumer supplies.
// It covers every declared event prop + trait + group prop, PLUS the two page prop keys
// (`path`/`referrer`) that `deriveAllowlistFromTaxonomy` deliberately omits.
const FERNLY_ALLOWLIST = [
  'plan',
  'documentId',
  'sizeBytes',
  'reviewerId',
  'resolved',
  'approved',
  'fromPlan',
  'toPlan',
  'at',
  'role',
  'email',
  'name',
  'seats',
  'path',
  'referrer',
];

const throwConfig: AnalyticsConfig & { taxonomy: typeof fernlyTaxonomy } = {
  key: 'k',
  taxonomy: fernlyTaxonomy,
  allowlist: FERNLY_ALLOWLIST,
  // onViolation omitted -> defaults to 'throw'.
};

const dropConfig: AnalyticsConfig & { taxonomy: typeof fernlyTaxonomy } = {
  key: 'k',
  taxonomy: fernlyTaxonomy,
  allowlist: FERNLY_ALLOWLIST,
  onViolation: 'drop-and-error-log',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Fernly allowlist + loud off-list failure at the neutral seam (E3)', () => {
  it('supplies the allowlist via config only; on-list props reach the recorded stream', () => {
    const { analytics, recorder } = createFernlyAnalytics(throwConfig);

    analytics.track('document_uploaded', { documentId: 'doc-1', sizeBytes: 4096 });
    analytics.track('signup_completed', { plan: 'pro' });

    expect(recorder.captures.map((c) => c.event)).toEqual([
      'document_uploaded',
      'signup_completed',
    ]);
    expect(recorder.captures[0]!.properties).toMatchObject({ documentId: 'doc-1', sizeBytes: 4096 });
    expect(recorder.captures[1]!.properties).toMatchObject({ plan: 'pro' });
  });

  it('lets an on-list register bag through to the recording adapter', () => {
    const { analytics, recorder } = createFernlyAnalytics(throwConfig);

    // `role` is on the allowlist -> the register bag reaches the recorder.
    analytics.register({ role: 'reviewer' });

    expect(recorder.registers).toHaveLength(1);
    expect(recorder.registers[0]!.props).toEqual({ role: 'reviewer' });
  });

  it('throws loudly on an off-list PII key under the default throw policy', () => {
    const { analytics, recorder } = createFernlyAnalytics(throwConfig);

    // Routed through register (props: Record<string, unknown>) so `ssn` COMPILES — an
    // off-list key on a taxonomy-typed bag (identify/track) is a compile error before it
    // can be a runtime violation. register hits the same allowlist gate and throws.
    expect(() => analytics.register({ ssn: '123-45-6789' })).toThrow(
      /property "ssn" is not on the payload allowlist/
    );

    // The loud failure fires BEFORE the adapter is touched — nothing off-list recorded.
    expect(recorder.registers).toHaveLength(0);
  });

  it('drops the off-list key and error-logs under onViolation: drop-and-error-log', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { analytics, recorder } = createFernlyAnalytics(dropConfig);

    // No throw under the drop policy — the off-list register is silently dropped.
    expect(() => analytics.register({ ssn: '123-45-6789' })).not.toThrow();

    // Nothing off-list reaches the recording adapter: the register stream is clean.
    expect(recorder.registers).toHaveLength(0);

    // The drop path error-logs the violation (loud in the logs, not the control flow).
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('property "ssn" is not on the payload allowlist')
    );
  });

  it('still passes on-list registers under the drop policy — only off-list keys are dropped', () => {
    // Regression pin: switching to drop-and-error-log must not gate on-list keys. An
    // on-list register still reaches the recorder; only the off-list key is suppressed.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { analytics, recorder } = createFernlyAnalytics(dropConfig);

    analytics.register({ role: 'reviewer' });
    analytics.register({ ssn: '123-45-6789' });

    expect(recorder.registers).toHaveLength(1);
    expect(recorder.registers[0]!.props).toEqual({ role: 'reviewer' });
  });

  it('derives an allowlist from the declared taxonomy shape (events + traits + groups, NOT page keys)', () => {
    // The derive-from-declared-shape path: instead of hand-writing the list, a consumer can
    // derive it from the taxonomy. It covers event props + traits + group props, but NOT
    // page prop keys — so `path`/`referrer` must be added explicitly if page props are tracked.
    const derived = deriveAllowlistFromTaxonomy(fernlyTaxonomy);

    expect(derived).toEqual(
      expect.arrayContaining([
        'plan', 'documentId', 'sizeBytes', 'reviewerId', 'resolved',
        'approved', 'fromPlan', 'toPlan', 'at', // event props
        'role', 'email', // traits
        'name', 'seats', // group props
      ])
    );
    expect(derived).not.toContain('path');
    expect(derived).not.toContain('referrer');

    // And the derived list is a real, usable config value: a harness built from it gates
    // the off-list PII key exactly like the hand-written list does.
    const { analytics } = createFernlyAnalytics({
      key: 'k',
      taxonomy: fernlyTaxonomy,
      allowlist: derived,
    });
    expect(() => analytics.register({ ssn: '123-45-6789' })).toThrow(
      /property "ssn" is not on the payload allowlist/
    );
  });

  it('does NOT gate when no allowlist is configured — pass-through is opt-in-by-omission', () => {
    // Regression pin on the seam contract: an undefined allowlist is pass-through (no
    // gating), so the allowlist MUST be explicitly set for the loud failure to fire. Proven
    // here so a future change can't silently start gating an unconfigured harness.
    const { analytics, recorder } = createFernlyAnalytics({ key: 'k', taxonomy: fernlyTaxonomy });

    expect(() => analytics.register({ ssn: '123-45-6789' })).not.toThrow();
    expect(recorder.registers).toHaveLength(1);
    expect(recorder.registers[0]!.props).toEqual({ ssn: '123-45-6789' });
  });
});
