import { gzipSync, type ZlibOptions } from 'node:zlib';

// `mtime` is a valid runtime gzip option (zeroes the wall-clock in the gzip header for
// deterministic output) but is absent from @types/node's `ZlibOptions`. Widen locally.
type GzipOptions = ZlibOptions & { mtime?: number };

// Node's OWN adapter-internal gzip primitive, de-branded from the reference. Uses the
// Node built-in `node:zlib` (zero new dependency, C-backed, synchronous), deliberately
// NOT the browser target's gzip module — that one is native-browser
// (`CompressionStream`/`Response`/`Blob`) with an `fflate` sync fallback node has no
// dependency on, and a cross-package import would breach the target isolation bar. The
// two targets share no gzip implementation, so there is nothing neutral to hoist.
//
// String in, gzip bytes out. `mtime: 0` drops the wall-clock from the gzip header so
// the compressed output is deterministic (reproducible bytes across runs). `gzipSync`
// returns a `Buffer` (a `Uint8Array` subclass) that drops straight onto a fetch body.
export function gzip(input: string): Buffer {
  const options: GzipOptions = { mtime: 0 };
  return gzipSync(Buffer.from(input, 'utf8'), options);
}
