import type { NeutralFetchResponse } from '@randomtoni/analytics-kit';
import {
  DEFAULT_BATCH_SCOPE,
  SERVER_COOLOFF_MS,
  type BackPressureInterpreter,
  type BackPressureSignal,
} from './rate-limiter';

// The [WIRE] back-pressure interpreter for THIS backend. This is the single place
// the backend's on-the-wire back-pressure vocabulary lives — everything that reads
// its response body and knows its field names is confined here, behind the neutral
// BackPressureInterpreter contract. A second backend ships its OWN interpreter
// (a header-borne Retry-After, a different JSON field) and constructs the same
// RateLimiter with it — zero change to the limiter, the gate, or the neutral
// surface (bar A).
//
// This backend signals back-pressure in the response BODY, not a header: a JSON
// object whose limited-scope list, when present and non-empty, means "back off".
// The neutral NeutralFetchResponse already exposes text() (adapter.ts) so the
// signal is read off that directly — the neutral type is NOT extended.

// The response-body field this backend uses to name the scopes it is currently
// limiting. Adapter-internal wire vocabulary — it appears ONLY here, never on the
// neutral surface.
const LIMITED_SCOPES_FIELD = 'quota_limited';

interface BackPressureBody {
  [LIMITED_SCOPES_FIELD]?: string[];
}

// Read the body-borne back-pressure signal and map every named scope to a
// cool-off directive. An empty/absent list, an empty body, or an unparseable body
// all mean "no back-pressure" — the send proceeds. Each named scope collapses to
// the adapter's single DEFAULT_BATCH_SCOPE (a one-endpoint adapter partitions
// back-pressure by exactly one scope), held for the ported cool-off window.
export const interpretBodyBackPressure: BackPressureInterpreter = async (
  response: NeutralFetchResponse
): Promise<BackPressureSignal[]> => {
  const text = await response.text();
  if (!text) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A non-JSON / malformed body is not a back-pressure signal — continue
    // sending rather than mistaking a parse failure for a limit.
    return [];
  }

  // JSON.parse of a valid-but-non-object body ('null', '42', '"x"', '[]') yields a
  // primitive/null/array on which a field access would throw. Only a plain object can
  // carry the limited-scope field — anything else is "no back-pressure".
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [];
  }
  const body = parsed as BackPressureBody;

  const limitedScopes = body[LIMITED_SCOPES_FIELD] ?? [];
  // A blind cast over JSON.parse: a malformed body (e.g. a bare string for the
  // limited-scope field) would otherwise pass the length check and spuriously arm a
  // cool-off. Only a non-empty ARRAY of scopes is back-pressure.
  if (!Array.isArray(limitedScopes) || limitedScopes.length === 0) {
    return [];
  }
  return [{ scope: DEFAULT_BATCH_SCOPE, cooloffMs: SERVER_COOLOFF_MS }];
};
