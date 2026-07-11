import { describe, expect, test } from 'vitest';
import type { NeutralFetchResponse } from '@randomtoni/analytics-kit';
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

  // A valid-JSON body that parses to a NON-OBJECT (null / number / string / array) must not
  // reach the field access — `JSON.parse('null')` is null, and `null[LIMITED_SCOPES_FIELD]`
  // would THROW. The post-parse guard returns [] for each without throwing.
  test.each(['null', '42', '"x"', '[]'])(
    'a valid-JSON but non-object body (%s) arms NO cool-off and does NOT throw (FIX #15)',
    async (bodyText) => {
      await expect(interpretBodyBackPressure(responseWithBody(bodyText))).resolves.toEqual([]);
    }
  );

  test('a JSON `null` body specifically does not throw on the field access (the reported crash)', async () => {
    // The exact reported defect: JSON.parse('null') → null, then body[LIMITED_SCOPES_FIELD]
    // threw a TypeError OUTSIDE the parse-only try/catch. The guard now short-circuits it.
    let result: unknown;
    await expect(
      (async () => {
        result = await interpretBodyBackPressure(responseWithBody('null'));
      })()
    ).resolves.toBeUndefined();
    expect(result).toEqual([]);
  });

  test('a JSON array body (a scope list at the ROOT, not under the field) arms NO cool-off', async () => {
    // Only a plain object can carry the limited-scope field; a bare array is not the shape.
    const signals = await interpretBodyBackPressure(responseWithBody(JSON.stringify(['events'])));
    expect(signals).toEqual([]);
  });
});
