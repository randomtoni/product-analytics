import { createAnalytics } from '@analytics-kit/browser';
import type { RootAnalytics } from '@analytics-kit/browser';
import type { SessionReplayConfig, SessionReplayPort } from 'analytics-kit';
import { fernlyTaxonomy } from './taxonomy';

// The masking policy Fernly ships as config (the NEW privacy surface, orthogonal to the
// event-property allowlist). Neutral CSS/DOM field names — no rrweb vocabulary reaches here.
export const FERNLY_REPLAY_MASKING: NonNullable<SessionReplayConfig['masking']> = {
  maskAllInputs: true,
  maskTextSelector: '[data-sensitive]',
  blockSelector: '.no-record',
};

// Build a REAL browser-adapter-backed client with replay ENABLED BY CONFIG ALONE (bar B):
// a keyed config + `sessionReplay: { enabled, sampleRate, masking }` populates `provider.replay`
// with the shipped ReplayRecorder (S2–S4), reached through the neutral SessionReplayPort. No
// Fernly library edit — the recorder, rrweb, delivery, masking, and sampling all live behind the
// browser adapter. `getReplayId()` reads the SHARED session id the browser adapter stamps on
// captured events (S3 linkage), so recording and events stitch on one id.
export function createFernlyReplayClient(
  overrides: Partial<SessionReplayConfig> = {}
): RootAnalytics {
  return createAnalytics({
    key: 'fernly-replay-key',
    ingestHost: 'https://ingest.fernly.example',
    taxonomy: fernlyTaxonomy,
    consentDefault: 'granted',
    sessionReplay: {
      enabled: true,
      sampleRate: 1,
      masking: FERNLY_REPLAY_MASKING,
      ...overrides,
    },
  });
}

// An in-example fake SessionReplayPort over an in-memory recording state — the bar-A swap
// target. A consumer's replay-control calls (start/stop/isActive/getReplayId) are byte-identical
// whether they run against this fake or the real browser ReplayRecorder; this fake exists ONLY to
// prove that swap-equivalence (it does no rrweb recording, no delivery, no session-id sourcing —
// it mints its own opaque id when active). It satisfies the SAME 4-verb neutral port.
export function createFakeReplayPort(replayId = 'mock-replay-id'): SessionReplayPort {
  let active = false;
  return {
    start: () => {
      active = true;
    },
    stop: () => {
      active = false;
    },
    isActive: () => active,
    getReplayId: () => (active ? replayId : undefined),
  };
}
