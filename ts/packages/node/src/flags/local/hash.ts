import { createHash } from 'node:crypto';

// The consistent-hash bucketing primitive shared by rollout gating and variant banding, ported
// VERBATIM in algorithm from posthog's node local evaluator — only the naming is de-branded.
// De-branded from posthog's feature-flags.ts `_hash`/`LONG_SCALE` and crypto.ts `hashSHA1`.
//
// The constant, the SHA-1 concat shape, and the 15-hex-nibble slice are the load-bearing
// cross-tree parity invariant: the same (flagKey, bucketingValue, salt) MUST produce the same
// float here, in a remote eval, and in the Python port — bit-identical — or local and remote
// disagree for the same actor. Do NOT "improve" any of it.

// A 40-char lowercase-hex SHA-1 digest of `text`, computed SYNCHRONOUSLY via node's crypto. The
// reference awaits WebCrypto's `subtle.digest` (browser); node's `createHash` is synchronous, so
// the whole matcher stays a plain sync function of its inputs — no Promise, no await.
export function hashSHA1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

// The divisor: 0xfffffffffffffff — exactly FIFTEEN f's = 2^60 − 1 = 1152921504606846975, kept a
// FLOAT so the division is float64. The 60-bit numerator exceeds Number.MAX_SAFE_INTEGER, but
// immediate float division matches Python's `int / float(...)`; an integer-divide would drift. The
// precision "loss" is the intended float64 behavior (the reference disables the same lint here).
// eslint-disable-next-line no-loss-of-precision
const LONG_SCALE = 0xfffffffffffffff;

// Map a (flagKey, bucketingValue, salt) triple to a deterministic [0, 1] float, uniformly
// distributed, TOP-INCLUSIVE: an all-`f` slice yields exactly 1.0 (do NOT renormalize to [0,1)) —
// the 100%-rollout gate depends on `1.0 <= 1.0`. The `.` separator sits between key and
// bucketingValue ONLY; `salt` is a suffix on bucketingValue with NO separator. Rollout salt is
// '' (the default); variant banding passes the literal 'variant'.
export function bucketHash(key: string, bucketingValue: string, salt = ''): number {
  const digest = hashSHA1(`${key}.${bucketingValue}${salt}`);
  return parseInt(digest.slice(0, 15), 16) / LONG_SCALE;
}
