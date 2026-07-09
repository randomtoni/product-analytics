import { hasDocument } from './dom';
import { generateUuidV7 } from './uuid-v7';

// The neutral role name for the throwaway cookie the public-suffix probe writes
// and immediately reads back. De-branded from the reference's domain-check name —
// no vendor token, no `$` / `ph_` prefix.
const PROBE_COOKIE_PREFIX = 'domain_probe_';

// Paranoia cap: a hostname has few labels; walking more than this is a sign of a
// pathological input, not a real domain.
const MAX_DOMAIN_LABELS = 8;

interface CookieJar {
  cookie: string;
}

// Browsers offer no API to test whether a domain is a public suffix (`.co.uk`,
// `.io`, …), but they REJECT a cookie set on one. So we walk the hostname's
// labels from the shortest candidate upward, writing a throwaway probe cookie at
// each `.<candidate>` domain; the first the browser accepts is the widest
// non-public domain the identity cookie can be shared across.
//
// The probe writes cookies as a side effect — it must therefore run only when
// consent is granted (its sole caller sits in the granted-only backend build
// path). De-branded port of the reference `seekFirstNonPublicSubDomain`.
export function seekFirstNonPublicSubDomain(
  hostname: string,
  cookieJar: CookieJar | undefined = hasDocument() ? document : undefined
): string {
  if (!cookieJar) {
    return '';
  }
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return '';
  }

  const labels = hostname.split('.');
  let index = Math.min(labels.length, MAX_DOMAIN_LABELS);
  const probeKey = `${PROBE_COOKIE_PREFIX}${generateUuidV7()}`;
  let found = '';

  while (!found && index--) {
    const candidate = labels.slice(index).join('.');
    const probeCookie = `${probeKey}=1;domain=.${candidate};path=/`;

    // Short max-age: the browser only needs to accept-or-reject; we read back
    // immediately, then delete with max-age=0.
    cookieJar.cookie = `${probeCookie};max-age=3`;

    if (cookieJar.cookie.includes(probeKey)) {
      cookieJar.cookie = `${probeCookie};max-age=0`;
      found = candidate;
    }
  }

  return found;
}

export interface ResolveCookieDomainOptions {
  configDomain?: string;
  crossSubdomain?: boolean;
}

// Config-authoritative else probe. A consumer-supplied `configDomain` wins and
// the probe NEVER runs (no throwaway cookie). Only when it is unset AND
// cross-subdomain sharing is requested does the probe derive the domain. The
// return is the bare domain (no leading dot) or undefined for a host-only cookie;
// `createCookieBackend` applies the `.` and `domain=` attribute. The registrable
// regex fallback is deliberately omitted: `configDomain` is authoritative and the
// probe is the only derivation — a fragile regex guess is not a safe last resort.
export function resolveCookieDomain(options: ResolveCookieDomainOptions): string | undefined {
  if (options.configDomain !== undefined) {
    return options.configDomain;
  }
  if (!options.crossSubdomain) {
    return undefined;
  }
  if (!hasDocument()) {
    return undefined;
  }
  const probed = seekFirstNonPublicSubDomain(document.location.hostname);
  return probed || undefined;
}
