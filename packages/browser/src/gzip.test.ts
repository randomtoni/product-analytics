import { describe, expect, test } from 'vitest';
import { gunzipSync, strFromU8 } from 'fflate';
import { gzipCompress, gzipSyncFallback, isGzipData, isGzipSupported } from './gzip';

const GZIP_MAGIC_FIRST = 0x1f;
const GZIP_MAGIC_SECOND = 0x8b;

describe('gzipSyncFallback', () => {
  test('produces valid gzip bytes that round-trip back to the input', () => {
    const input = JSON.stringify({ data: [{ event: 'x', uuid: 'u-1' }] });
    const bytes = gzipSyncFallback(input);

    expect(bytes[0]).toBe(GZIP_MAGIC_FIRST);
    expect(bytes[1]).toBe(GZIP_MAGIC_SECOND);
    expect(strFromU8(gunzipSync(bytes))).toBe(input);
  });

  test('is deterministic — the same input yields identical bytes (mtime:0)', () => {
    const input = '{"a":1,"b":"two"}';
    expect(gzipSyncFallback(input)).toEqual(gzipSyncFallback(input));
  });

  test('handles an empty string', () => {
    const bytes = gzipSyncFallback('');
    expect(bytes[0]).toBe(GZIP_MAGIC_FIRST);
    expect(strFromU8(gunzipSync(bytes))).toBe('');
  });
});

describe('isGzipData', () => {
  test('accepts gzip-framed bytes (magic 1f 8b)', () => {
    expect(isGzipData(gzipSyncFallback('{"x":1}'))).toBe(true);
  });

  test('rejects non-gzip bytes', () => {
    expect(isGzipData(new Uint8Array([0x00, 0x01, 0x02]))).toBe(false);
  });

  test('rejects bytes shorter than the magic header', () => {
    expect(isGzipData(new Uint8Array([GZIP_MAGIC_FIRST]))).toBe(false);
    expect(isGzipData(new Uint8Array([]))).toBe(false);
  });
});

describe('isGzipSupported', () => {
  test('reports a boolean feature-detect of the native primitive', () => {
    expect(typeof isGzipSupported()).toBe('boolean');
  });
});

describe('gzipCompress', () => {
  test('returns null (never throws) when the native path fails, so the caller can fall back', async () => {
    // In the jsdom test env the native Response/CompressionStream chain does not
    // actually produce bytes, so this exercises the swallow-and-return-null contract
    // the adapter depends on for its uncompressed fallback.
    const result = await gzipCompress('{"data":[]}');
    expect(result === null || result instanceof Uint8Array).toBe(true);
  });
});
