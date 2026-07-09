import { describe, expect, test } from 'vitest';
import {
  detectDevice,
  detectDeviceType,
  detectOS,
  parseUserAgent,
} from './user-agent';

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FIREFOX_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0';
const SAFARI_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1';
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const EDGE_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';

describe('parseUserAgent — representative desktop/mobile UAs', () => {
  test('Chrome on macOS', () => {
    expect(parseUserAgent(CHROME_MAC)).toEqual({
      browser: 'Chrome',
      browserVersion: 120,
      os: 'Mac OS X',
      osVersion: '10.15.7',
    });
  });

  test('Firefox on Windows', () => {
    expect(parseUserAgent(FIREFOX_WIN)).toEqual({
      browser: 'Firefox',
      browserVersion: 121,
      os: 'Windows',
      osVersion: '10',
    });
  });

  test('Safari on macOS (needs navigator.vendor to disambiguate)', () => {
    const parsed = parseUserAgent(SAFARI_MAC, 'Apple Computer, Inc.');
    expect(parsed.browser).toBe('Safari');
    expect(parsed.browserVersion).toBe(17.1);
    expect(parsed.os).toBe('Mac OS X');
  });

  test('Mobile Safari on iPhone', () => {
    const parsed = parseUserAgent(SAFARI_IPHONE, 'Apple Computer, Inc.');
    expect(parsed.browser).toBe('Mobile Safari');
    expect(parsed.os).toBe('iOS');
    expect(parsed.osVersion).toBe('17.1.0');
  });

  test('Chrome on Android — a bare "Android 13" (no dotted version) yields an empty os version', () => {
    const parsed = parseUserAgent(CHROME_ANDROID);
    expect(parsed.browser).toBe('Chrome');
    expect(parsed.os).toBe('Android');
    expect(parsed.osVersion).toBe('');
  });

  test('Chrome on Android — a dotted "Android 13.0.0" yields the parsed os version', () => {
    const dotted =
      'Mozilla/5.0 (Linux; Android 13.0.0; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
    const parsed = parseUserAgent(dotted);
    expect(parsed.os).toBe('Android');
    expect(parsed.osVersion).toBe('13.0.0');
  });

  test('Microsoft Edge is detected ahead of the embedded Chrome/ marker', () => {
    expect(parseUserAgent(EDGE_WIN).browser).toBe('Microsoft Edge');
  });

  test('the brave hint wins over UA sniffing (desktop Brave has no UA marker)', () => {
    const parsed = parseUserAgent(CHROME_MAC, undefined, { brave: true });
    expect(parsed.browser).toBe('Brave');
    // Desktop Brave carries no parseable version marker.
    expect(parsed.browserVersion).toBeNull();
  });
});

describe('parseUserAgent — edge cases and purity', () => {
  test('an unrecognized UA yields empty browser/os and a null version — not a throw', () => {
    expect(parseUserAgent('totally-unknown-agent/1.0')).toEqual({
      browser: '',
      browserVersion: null,
      os: '',
      osVersion: '',
    });
  });

  test('an empty UA string yields all-absent fields', () => {
    expect(parseUserAgent('')).toEqual({
      browser: '',
      browserVersion: null,
      os: '',
      osVersion: '',
    });
  });

  test('is pure: same input → same output', () => {
    expect(parseUserAgent(CHROME_MAC)).toEqual(parseUserAgent(CHROME_MAC));
  });

  test('reads NO globals — deleting navigator/window/document does not change the result', () => {
    const globalObj = globalThis as Record<string, unknown>;
    const savedNav = globalObj.navigator;
    const savedWin = globalObj.window;
    const savedDoc = globalObj.document;
    // Prove the parser touches no DOM: strip the globals entirely, and assert the
    // result is identical to the jsdom-present run. A DOM read would throw or diverge.
    try {
      delete globalObj.navigator;
      delete globalObj.window;
      delete globalObj.document;
      expect(parseUserAgent(CHROME_MAC)).toEqual({
        browser: 'Chrome',
        browserVersion: 120,
        os: 'Mac OS X',
        osVersion: '10.15.7',
      });
    } finally {
      globalObj.navigator = savedNav;
      globalObj.window = savedWin;
      globalObj.document = savedDoc;
    }
  });
});

describe('detectDeviceType — screen-signal tiebreak stays out of the pure parser', () => {
  test('a desktop UA is Desktop', () => {
    expect(detectDeviceType(CHROME_MAC)).toBe('Desktop');
  });

  test('an iPhone UA is Mobile', () => {
    expect(detectDeviceType(SAFARI_IPHONE)).toBe('Mobile');
  });

  test('an iPad UA is Tablet', () => {
    const ipad =
      'Mozilla/5.0 (iPad; CPU OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1';
    expect(detectDeviceType(ipad)).toBe('Tablet');
  });

  test('an Android-spoofing-desktop UA with touch + tablet screen resolves to Tablet via signals', () => {
    const spoof =
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    expect(
      detectDeviceType(spoof, {
        userAgentDataPlatform: 'Android',
        maxTouchPoints: 5,
        screenWidth: 1200,
        screenHeight: 1600,
        devicePixelRatio: 2,
      })
    ).toBe('Tablet');
  });

  test('the same spoof UA with a phone-sized screen resolves to Mobile', () => {
    const spoof =
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    expect(
      detectDeviceType(spoof, {
        userAgentDataPlatform: 'Android',
        maxTouchPoints: 5,
        screenWidth: 400,
        screenHeight: 800,
        devicePixelRatio: 3,
      })
    ).toBe('Mobile');
  });
});

describe('detectOS / detectDevice ports', () => {
  test('detectOS returns a [name, version] pair', () => {
    expect(detectOS(FIREFOX_WIN)).toEqual(['Windows', '10']);
  });

  test('detectDevice classifies an iPhone', () => {
    expect(detectDevice(SAFARI_IPHONE)).toBe('iPhone');
  });

  test('detectDevice returns empty for a desktop UA', () => {
    expect(detectDevice(CHROME_MAC)).toBe('');
  });
});
