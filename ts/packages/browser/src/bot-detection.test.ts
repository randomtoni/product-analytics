import { describe, expect, test } from 'vitest';
import { DEFAULT_BLOCKED_UA_STRS, isBlockedUA, isLikelyBot } from './bot-detection';

describe('isBlockedUA — default denylist substring match', () => {
  test('a real browser UA is not blocked', () => {
    const chrome =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
    expect(isBlockedUA(chrome)).toBe(false);
  });

  test('a denylisted crawler UA is blocked', () => {
    expect(isBlockedUA('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBe(true);
  });

  test('the match is case-insensitive', () => {
    expect(isBlockedUA('SOMETHING GOOGLEBOT SOMETHING')).toBe(true);
  });

  test('a bare "crawler" substring anywhere in the UA is blocked', () => {
    expect(isBlockedUA('my-internal-Crawler/1.0')).toBe(true);
  });

  test('an undefined UA is never a bot', () => {
    expect(isBlockedUA(undefined)).toBe(false);
  });

  test('an empty UA is never a bot', () => {
    expect(isBlockedUA('')).toBe(false);
  });
});

describe('isBlockedUA — consumer extension', () => {
  test('a consumer-supplied substring blocks a UA the default list misses', () => {
    const ua = 'Mozilla/5.0 AcmeInternalScanner/3.2';
    expect(isBlockedUA(ua)).toBe(false);
    expect(isBlockedUA(ua, ['acmeinternalscanner'])).toBe(true);
  });

  test('the consumer extension is also matched case-insensitively', () => {
    expect(isBlockedUA('runs MyCustomBot here', ['mycustombot'])).toBe(true);
  });
});

describe('isLikelyBot — navigator-level signals', () => {
  test('an undefined navigator is never a bot', () => {
    expect(isLikelyBot(undefined, [])).toBe(false);
  });

  test('a plain browser navigator is not a bot', () => {
    const nav = { userAgent: 'Mozilla/5.0 Chrome/120', webdriver: false } as Navigator;
    expect(isLikelyBot(nav, [])).toBe(false);
  });

  test('navigator.webdriver flags an automated client even with a clean UA', () => {
    const nav = { userAgent: 'Mozilla/5.0 Chrome/120', webdriver: true } as unknown as Navigator;
    expect(isLikelyBot(nav, [])).toBe(true);
  });

  test('a denylisted userAgent flags a bot regardless of webdriver', () => {
    const nav = { userAgent: 'Googlebot/2.1', webdriver: false } as Navigator;
    expect(isLikelyBot(nav, [])).toBe(true);
  });

  test('a denylisted userAgentData brand flags a bot', () => {
    const nav = {
      userAgent: 'Mozilla/5.0 Chrome/120',
      webdriver: false,
      userAgentData: { brands: [{ brand: 'HeadlessChrome', version: '120' }] },
    } as unknown as Navigator;
    expect(isLikelyBot(nav, [])).toBe(true);
  });

  test('a consumer extension flags an otherwise-clean navigator', () => {
    const nav = { userAgent: 'Mozilla/5.0 AcmeScanner/1', webdriver: false } as Navigator;
    expect(isLikelyBot(nav, [])).toBe(false);
    expect(isLikelyBot(nav, ['acmescanner'])).toBe(true);
  });
});

describe('denylist hygiene', () => {
  test('carries the full ported substring set (1:1 with the source list)', () => {
    expect(DEFAULT_BLOCKED_UA_STRS).toHaveLength(77);
  });

  test('carries no vendor name (grep-clean neutral UA substrings)', () => {
    for (const entry of DEFAULT_BLOCKED_UA_STRS) {
      expect(entry.toLowerCase()).not.toContain('posthog');
    }
  });
});
