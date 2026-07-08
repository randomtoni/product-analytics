import { gzipSync, strToU8 } from 'fflate';

// Adapter-internal gzip primitives, de-branded from the reference implementation.
// A pure utility: string in, gzip bytes out, plus format validation. It knows
// nothing about transport, URLs, config, or the neutral surface — the adapter
// orchestrates when to compress and where the bytes go. A future backend adapter
// that speaks a different wire is free to ignore this module entirely, so it lives
// in the target package, not the neutral seam.

const GZIP_MAGIC_FIRST_BYTE = 0x1f;
const GZIP_MAGIC_SECOND_BYTE = 0x8b;
const GZIP_DEFLATE_METHOD = 0x08;

// Native gzip trailer is the 8-byte CRC32 + input-size footer; a valid stream is at
// least the 10-byte header + 8-byte trailer.
const GZIP_MIN_VALID_SIZE = 18;

const hasGzipMagic = (bytes: Uint8Array): boolean =>
  bytes.length >= 2 && bytes[0] === GZIP_MAGIC_FIRST_BYTE && bytes[1] === GZIP_MAGIC_SECOND_BYTE;

// Confirm a body is actually gzip-framed before shipping it as such — a cheap guard
// that catches a native path that silently returned non-gzip bytes.
export const isGzipData = (body: Uint8Array): boolean => hasGzipMagic(body);

// Feature-detect the native compression primitive. The fallback decision is a
// runtime concern, not a type one — under lib:["ES2022","DOM"] the symbols are typed,
// but they may be absent at runtime (older browser, SSR, React Native).
export function isGzipSupported(): boolean {
  return (
    'CompressionStream' in globalThis &&
    'TextEncoder' in globalThis &&
    'Response' in globalThis &&
    typeof Response.prototype.blob === 'function'
  );
}

let crc32Table: number[] | undefined;

const getCrc32Table = (): number[] => {
  if (crc32Table) {
    return crc32Table;
  }
  const table: number[] = [];
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[i] = crc >>> 0;
  }
  crc32Table = table;
  return table;
};

const crc32 = (bytes: Uint8Array): number => {
  const table = getCrc32Table();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

type GzipValidationReason = 'too-short' | 'invalid-header' | 'invalid-crc' | 'invalid-size';

class GzipValidationError extends Error {
  constructor(reason: GzipValidationReason) {
    super(`Native gzip produced invalid output: ${reason}`);
    this.name = 'GzipValidationError';
  }
}

// Reject a bad native compression result rather than ship corrupt bytes: verify the
// gzip header magic + deflate method, then the trailer's CRC32 and input-size fields
// against the original bytes. A mismatch throws, which the caller catches to fall
// back to the uncompressed path.
const validateNativeGzip = async (compressed: Blob, inputBytes: Uint8Array): Promise<void> => {
  if (compressed.size < GZIP_MIN_VALID_SIZE) {
    throw new GzipValidationError('too-short');
  }

  const header = new Uint8Array(await compressed.slice(0, 10).arrayBuffer());
  if (!hasGzipMagic(header) || header[2] !== GZIP_DEFLATE_METHOD) {
    throw new GzipValidationError('invalid-header');
  }

  const trailer = new DataView(await compressed.slice(compressed.size - 8).arrayBuffer());
  if (trailer.getUint32(0, true) !== crc32(inputBytes)) {
    throw new GzipValidationError('invalid-crc');
  }

  const inputSize = inputBytes.length >>> 0;
  if (trailer.getUint32(4, true) !== inputSize) {
    throw new GzipValidationError('invalid-size');
  }
};

// Gzip a string via the native Compression Streams API, validating the output before
// returning it. Returns the gzip bytes as a Uint8Array — the transport-agnostic shape
// (fetch, XHR, and sendBeacon all accept it), NOT a Blob. Returns null on any failure
// so the caller falls back rather than throwing on the capture hot path.
export async function gzipCompress(input: string): Promise<Uint8Array | null> {
  try {
    const inputBytes = new TextEncoder().encode(input);
    const compressedStream = new CompressionStream('gzip');
    const writer = compressedStream.writable.getWriter();

    const writePromise = writer
      .write(inputBytes)
      .then(() => writer.close())
      .catch(async (err) => {
        try {
          await writer.abort(err);
        } catch {
          // Ignore abort failures; rethrow the original compression error below.
        }
        throw err;
      });
    const responsePromise = new Response(compressedStream.readable).blob();

    const [compressed] = await Promise.all([responsePromise, writePromise]);
    await validateNativeGzip(compressed, inputBytes);
    return new Uint8Array(await compressed.arrayBuffer());
  } catch {
    return null;
  }
}

// Synchronous gzip fallback for when the native async primitive is unavailable or its
// output failed validation. mtime:0 makes the output deterministic (no wall-clock in
// the header), which keeps the bytes reproducible.
export function gzipSyncFallback(input: string): Uint8Array {
  return gzipSync(strToU8(input), { mtime: 0 });
}
