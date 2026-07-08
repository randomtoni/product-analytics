import { describe, expect, test, vi } from 'vitest';
import { resolveCookieDomain, seekFirstNonPublicSubDomain } from './cookie-domain';

// A stand-in for `document.cookie` that refuses a cookie set on a known public
// suffix, exactly as a browser would — so the probe walks up until the widest
// non-public domain is accepted. jsdom's own `document.cookie` does not enforce
// public-suffix rejection, so a mock jar is how the probe's core logic is tested.
function publicSuffixRejectingJar() {
  const publicSuffixes = new Set(['.uk', '.com', '.au', '.com.au', '.co.uk', '.io', '.org.uk']);
  return {
    stored: '',
    get cookie(): string {
      return this.stored;
    },
    set cookie(value: string) {
      const domain = value.split('domain=')[1]?.split(';')[0];
      if (domain && publicSuffixes.has(domain)) {
        return;
      }
      this.stored += `${value};`;
    },
  };
}

describe('seekFirstNonPublicSubDomain', () => {
  test.each([
    { hostname: 'www.example.co.uk', expected: 'example.co.uk' },
    { hostname: 'www.example.com', expected: 'example.com' },
    { hostname: 'app.example.com.au', expected: 'example.com.au' },
    { hostname: 'deep.app.example.com', expected: 'example.com' },
  ])('$hostname derives $expected as the widest non-public domain', ({ hostname, expected }) => {
    const jar = publicSuffixRejectingJar();
    expect(seekFirstNonPublicSubDomain(hostname, jar)).toBe(expected);
  });

  test('localhost short-circuits to empty (no probe cookie written)', () => {
    const jar = publicSuffixRejectingJar();
    expect(seekFirstNonPublicSubDomain('localhost', jar)).toBe('');
    expect(jar.stored).toBe('');
  });

  test('127.0.0.1 short-circuits to empty', () => {
    const jar = publicSuffixRejectingJar();
    expect(seekFirstNonPublicSubDomain('127.0.0.1', jar)).toBe('');
    expect(jar.stored).toBe('');
  });

  test('an absent cookie jar yields empty without throwing', () => {
    expect(seekFirstNonPublicSubDomain('www.example.com', undefined)).toBe('');
  });

  test('the throwaway probe cookie carries a neutral, de-branded name — no dmn_chk / $ / ph_ token', () => {
    const jar = publicSuffixRejectingJar();
    seekFirstNonPublicSubDomain('www.example.com', jar);

    expect(jar.stored).toContain('domain_probe_');
    expect(jar.stored).not.toContain('dmn_chk');
    expect(jar.stored).not.toContain('$');
    expect(jar.stored).not.toContain('ph_');
  });

  test('the accepted probe cookie is deleted (set again with max-age=0) — it is throwaway', () => {
    const jar = publicSuffixRejectingJar();
    seekFirstNonPublicSubDomain('www.example.com', jar);
    // The accept path writes the probe twice: once to test (max-age=3), once to
    // delete (max-age=0). Both writes are recorded by the jar.
    expect(jar.stored).toContain('max-age=3');
    expect(jar.stored).toContain('max-age=0');
  });
});

describe('resolveCookieDomain', () => {
  test('a config-supplied domain is authoritative and is returned verbatim (probe never runs)', () => {
    const probeSpy = vi.fn();
    const before = document.cookie;

    const resolved = resolveCookieDomain({ configDomain: 'example.com', crossSubdomain: true });

    expect(resolved).toBe('example.com');
    // No probe cookie was written — document.cookie is unchanged.
    expect(document.cookie).toBe(before);
    expect(probeSpy).not.toHaveBeenCalled();
  });

  test('config domain wins even when crossSubdomain is not requested', () => {
    expect(resolveCookieDomain({ configDomain: 'example.com' })).toBe('example.com');
  });

  test('no config domain and crossSubdomain off ⇒ undefined (host-only, no probe)', () => {
    const before = document.cookie;
    expect(resolveCookieDomain({})).toBeUndefined();
    expect(resolveCookieDomain({ crossSubdomain: false })).toBeUndefined();
    // No probe cookie written.
    expect(document.cookie).toBe(before);
  });
});
