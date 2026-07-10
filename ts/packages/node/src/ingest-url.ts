// The single node host-join used by every server-side URL builder (capture batch, flag-eval, flag
// definitions). One normalization for all of them so a trailing-slash origin can't yield an
// inconsistent URL (a `//` in one path, a stripped segment in another) across capture vs flags.
//
// Host normalization is the strict form: trim surrounding whitespace, then strip ALL trailing
// slashes. The per-path [WIRE] const stays at the call site (they legitimately differ — the batch
// path, the flag-eval path, the definitions path); this helper only owns the origin+separator join.

// Join a bare host/origin to an adapter [WIRE] path, normalizing the host and collapsing the seam to
// exactly one slash. A leading slash on `path` is optional — the join adds one when absent — so a
// consumer-supplied path with or without it lands on the same URL.
export function joinHostPath(host: string, path: string): string {
  const normalizedHost = host.trim().replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedHost}${normalizedPath}`;
}
