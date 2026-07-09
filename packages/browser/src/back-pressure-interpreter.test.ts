import { describe, expect, test } from 'vitest';
import type { NeutralFetchResponse } from 'analytics-kit';
import { interpretBodyBackPressure } from './back-pressure-interpreter';
import { DEFAULT_BATCH_SCOPE, SERVER_COOLOFF_MS } from './rate-limiter';

// Build a neutral response whose body is exactly `text`. json() is present to
// satisfy the SPI but the interpreter reads the body-borne signal off text().
function responseWithBody(text: string, status = 200): NeutralFetchResponse {
  return {
    status,
    text: async () => text,
    json: async () => (text ? JSON.parse(text) : {}),
  };
}

describe('interpretBodyBackPressure — [WIRE] body-borne signal', () => {
  test('a body naming limited scopes yields a single default-scope cool-off directive', async () => {
    const signals = await interpretBodyBackPressure(
      responseWithBody(JSON.stringify({ quota_limited: ['events'] }))
    );
    expect(signals).toEqual([{ scope: DEFAULT_BATCH_SCOPE, cooloffMs: SERVER_COOLOFF_MS }]);
  });

  test('multiple named scopes still collapse to the one default scope (single endpoint)', async () => {
    const signals = await interpretBodyBackPressure(
      responseWithBody(JSON.stringify({ quota_limited: ['events', 'recordings'] }))
    );
    expect(signals).toEqual([{ scope: DEFAULT_BATCH_SCOPE, cooloffMs: SERVER_COOLOFF_MS }]);
  });

  test('an empty limited-scope list is not back-pressure — no directive', async () => {
    const signals = await interpretBodyBackPressure(
      responseWithBody(JSON.stringify({ quota_limited: [] }))
    );
    expect(signals).toEqual([]);
  });

  test('a body without the limited-scope field is not back-pressure — no directive', async () => {
    const signals = await interpretBodyBackPressure(
      responseWithBody(JSON.stringify({ status: 'ok' }))
    );
    expect(signals).toEqual([]);
  });

  test('an empty body is not back-pressure — no directive', async () => {
    const signals = await interpretBodyBackPressure(responseWithBody(''));
    expect(signals).toEqual([]);
  });

  test('an unparseable (non-JSON) body is not mistaken for back-pressure — no directive', async () => {
    const signals = await interpretBodyBackPressure(responseWithBody('<html>gateway error</html>'));
    expect(signals).toEqual([]);
  });

  test('a NON-ARRAY limited-scope field (a bare string) arms NO cool-off (FIX C)', async () => {
    // `body` is a blind cast over JSON.parse; a malformed `{"quota_limited":"events"}`
    // makes the field the string "events" (.length===6), which without the Array guard
    // would spuriously arm a 60s cool-off. Only a non-empty ARRAY is back-pressure.
    const signals = await interpretBodyBackPressure(
      responseWithBody(JSON.stringify({ quota_limited: 'events' }))
    );
    expect(signals).toEqual([]);
  });

  test('a numeric limited-scope field arms NO cool-off (FIX C — non-array guard)', async () => {
    const signals = await interpretBodyBackPressure(
      responseWithBody(JSON.stringify({ quota_limited: 5 }))
    );
    expect(signals).toEqual([]);
  });

  test('an OBJECT (non-array) limited-scope field arms NO cool-off (FIX C — non-array guard)', async () => {
    const signals = await interpretBodyBackPressure(
      responseWithBody(JSON.stringify({ quota_limited: { events: true } }))
    );
    expect(signals).toEqual([]);
  });

  test('reads the signal off the BODY regardless of status (a 200 may carry back-pressure)', async () => {
    const signals = await interpretBodyBackPressure(
      responseWithBody(JSON.stringify({ quota_limited: ['events'] }), 200)
    );
    expect(signals).toHaveLength(1);
  });
});
