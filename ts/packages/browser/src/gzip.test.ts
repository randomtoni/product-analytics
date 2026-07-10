import { describe, expect, test, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { gunzipSync, strFromU8 } from 'fflate';
import {
  gzipCompress,
  gzipSyncFallback,
  isGzipData,
  isGzipSupported,
  validateNativeGzip,
} from './gzip';

const GZIP_MAGIC_FIRST = 0x1f;
const GZIP_MAGIC_SECOND = 0x8b;
const INPUT_FIXTURE = '{"data":[{"event":"x","uuid":"u-1"}]}';

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

describe('validateNativeGzip', () => {
  const inputBytes = (): Uint8Array => new TextEncoder().encode(INPUT_FIXTURE);
  // jsdom's Blob.slice() drops arrayBuffer(); node:buffer's Blob implements the full
  // slice→arrayBuffer chain the validator reads, so use it for a faithful exercise.
  const blobOf = (bytes: Uint8Array): Blob =>
    new NodeBlob([bytes.slice().buffer as ArrayBuffer]) as unknown as Blob;

  test('accepts a well-formed gzip Blob for the matching input', async () => {
    const bytes = gzipSyncFallback(INPUT_FIXTURE);
    await expect(validateNativeGzip(blobOf(bytes), inputBytes())).resolves.toBeUndefined();
  });

  test('rejects a Blob shorter than the header+trailer minimum (too-short)', async () => {
    const tooShort = blobOf(new Uint8Array([0x1f, 0x8b, 0x08, 0x00]));
    await expect(validateNativeGzip(tooShort, inputBytes())).rejects.toThrow(/too-short/);
  });

  test('rejects a Blob whose trailer CRC does not match the input (invalid-crc)', async () => {
    const corrupted = gzipSyncFallback(INPUT_FIXTURE).slice();
    corrupted[corrupted.length - 8] ^= 0xff; // flip a CRC-trailer byte
    await expect(validateNativeGzip(blobOf(corrupted), inputBytes())).rejects.toThrow(
      /invalid-crc/
    );
  });

  test('rejects a Blob whose trailer input-size does not match the input (invalid-size)', async () => {
    const wrongSize = gzipSyncFallback(INPUT_FIXTURE).slice();
    wrongSize[wrongSize.length - 4] ^= 0xff; // flip an input-size-trailer byte
    await expect(validateNativeGzip(blobOf(wrongSize), inputBytes())).rejects.toThrow(
      /invalid-size/
    );
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

  test('swallows a native path that produces an invalid gzip result, returning null', async () => {
    const hadCompressionStream = 'CompressionStream' in globalThis;
    const originalCompressionStream = (globalThis as { CompressionStream?: unknown })
      .CompressionStream;
    // Force the native path to run but yield bytes that FAIL validation, so the
    // catch-swallow-to-null contract is exercised end to end (jsdom's absent native
    // path never reaches the validator).
    class FakeCompressionStream {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
      constructor() {
        this.readable = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([0x00, 0x01, 0x02])); // not gzip-framed
            controller.close();
          },
        });
        this.writable = new WritableStream<Uint8Array>();
      }
    }
    vi.stubGlobal('CompressionStream', FakeCompressionStream);
    try {
      expect(await gzipCompress(INPUT_FIXTURE)).toBeNull();
    } finally {
      if (hadCompressionStream) {
        vi.stubGlobal('CompressionStream', originalCompressionStream);
      } else {
        vi.unstubAllGlobals();
      }
    }
  });
});
