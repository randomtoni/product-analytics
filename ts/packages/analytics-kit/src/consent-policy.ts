import type { ConsentState } from './adapter';

// The single tri-state consent → opted-out resolver, shared by the facade
// (AnalyticsProviderImpl) and every adapter's own capture gate so the two can never
// drift. 'granted' captures; 'denied' opts out; 'pending' resolves against the config
// consent-default — unset is opt-out-by-default (the library's fail-safe).
export function resolveOptedOut(state: ConsentState, consentDefault?: ConsentState): boolean {
  if (state === 'granted') return false;
  if (state === 'denied') return true;
  return consentDefault !== 'granted';
}
