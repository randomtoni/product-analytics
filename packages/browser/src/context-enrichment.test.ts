import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildContext, type LibraryIdentity } from './context-enrichment';

const LIB: LibraryIdentity = { libraryId: 'analytics-kit-browser', libraryVersion: '0.0.0' };

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('buildContext — jsdom (DOM present)', () => {
  test('carries neutral page / device / referrer / timezone / lib keys — NONE $-prefixed', () => {
    vi.stubGlobal('navigator', {
      userAgent: CHROME_MAC,
      vendor: '',
      language: 'en-US',
      maxTouchPoints: 0,
    });

    const context = buildContext(LIB);

    // Page context (jsdom default location is http://localhost:3000/ or similar).
    expect(context).toHaveProperty('current_url');
    expect(context).toHaveProperty('host');
    expect(context).toHaveProperty('pathname');
    // Device / browser / OS.
    expect(context.browser).toBe('Chrome');
    expect(context.browser_version).toBe(120);
    expect(context.os).toBe('Mac OS X');
    expect(context.os_version).toBe('10.15.7');
    expect(context.device_type).toBe('Desktop');
    expect(context.browser_language).toBe('en-US');
    expect(typeof context.screen_height).toBe('number');
    expect(typeof context.screen_width).toBe('number');
    expect(typeof context.viewport_height).toBe('number');
    expect(typeof context.viewport_width).toBe('number');
    // Referrer (empty in jsdom → the neutral 'direct' default).
    expect(context.referrer).toBe('direct');
    expect(context.referring_domain).toBe('direct');
    // Timezone + lib.
    expect(typeof context.timezone).toBe('string');
    expect(typeof context.timezone_offset).toBe('number');
    expect(context.lib).toBe('analytics-kit-browser');
    expect(context.lib_version).toBe('0.0.0');

    // Bar A: no key is $-prefixed.
    for (const key of Object.keys(context)) {
      expect(key.startsWith('$')).toBe(false);
    }
  });

  test('a non-empty referrer yields the referrer + its host as referring_domain', () => {
    vi.stubGlobal('navigator', { userAgent: CHROME_MAC, vendor: '', language: 'en-US' });
    vi.spyOn(document, 'referrer', 'get').mockReturnValue('https://referrer.example.com/some/path?q=1');

    const context = buildContext(LIB);

    expect(context.referrer).toBe('https://referrer.example.com/some/path?q=1');
    expect(context.referring_domain).toBe('referrer.example.com');
  });

  test('a malformed referrer URL falls back to the direct referring_domain, not a throw', () => {
    vi.stubGlobal('navigator', { userAgent: CHROME_MAC, vendor: '', language: 'en-US' });
    vi.spyOn(document, 'referrer', 'get').mockReturnValue('not-a-valid-url');

    const context = buildContext(LIB);

    expect(context.referrer).toBe('not-a-valid-url');
    expect(context.referring_domain).toBe('direct');
  });

  test('the brave navigator hint attributes the browser as Brave', () => {
    vi.stubGlobal('navigator', { userAgent: CHROME_MAC, vendor: '', language: 'en-US', brave: {} });

    expect(buildContext(LIB).browser).toBe('Brave');
  });

  test('computes fresh on every call — a location change between calls is reflected', () => {
    vi.stubGlobal('navigator', { userAgent: CHROME_MAC, vendor: '', language: 'en-US' });
    const first = buildContext(LIB).pathname;
    window.history.pushState({}, '', '/changed-path');
    const second = buildContext(LIB).pathname;

    expect(first).not.toBe(second);
    expect(second).toBe('/changed-path');
  });

  test('device_type keys are absent when navigator has no userAgent, but page/screen still resolve', () => {
    vi.stubGlobal('navigator', { userAgent: '', vendor: '', language: 'en-US' });

    const context = buildContext(LIB);

    expect(context).not.toHaveProperty('browser');
    expect(context).not.toHaveProperty('device_type');
    // Page + screen + lib do not depend on the UA.
    expect(context).toHaveProperty('current_url');
    expect(context).toHaveProperty('screen_width');
    expect(context.lib).toBe('analytics-kit-browser');
  });
});

describe('buildContext — non-DOM degradation', () => {
  // Strip the DOM globals to prove enrichment degrades to absent keys, never a throw.
  function withoutDom(run: () => void): void {
    const globalObj = globalThis as Record<string, unknown>;
    const saved = {
      navigator: globalObj.navigator,
      window: globalObj.window,
      document: globalObj.document,
    };
    try {
      delete globalObj.navigator;
      delete globalObj.window;
      delete globalObj.document;
      run();
    } finally {
      globalObj.navigator = saved.navigator;
      globalObj.window = saved.window;
      globalObj.document = saved.document;
    }
  }

  test('does not throw with no DOM, and still carries lib + timezone', () => {
    withoutDom(() => {
      const context = buildContext(LIB);
      expect(context.lib).toBe('analytics-kit-browser');
      expect(context.lib_version).toBe('0.0.0');
      expect(typeof context.timezone_offset).toBe('number');
    });
  });

  test('page / device / referrer keys are ABSENT when there is no DOM', () => {
    withoutDom(() => {
      const context = buildContext(LIB);
      expect(context).not.toHaveProperty('current_url');
      expect(context).not.toHaveProperty('host');
      expect(context).not.toHaveProperty('pathname');
      expect(context).not.toHaveProperty('browser');
      expect(context).not.toHaveProperty('device_type');
      expect(context).not.toHaveProperty('screen_width');
      expect(context).not.toHaveProperty('referrer');
      expect(context).not.toHaveProperty('referring_domain');
    });
  });
});

describe('buildContext — E6-S5 per-group opt-out toggles', () => {
  function stubNavigator(): void {
    vi.stubGlobal('navigator', {
      userAgent: CHROME_MAC,
      vendor: '',
      language: 'en-US',
      maxTouchPoints: 0,
    });
    vi.spyOn(document, 'referrer', 'get').mockReturnValue('https://ref.example.com/x');
  }

  test('default (no toggles) enriches all three groups', () => {
    stubNavigator();
    const context = buildContext(LIB);
    expect(context).toHaveProperty('current_url');
    expect(context.browser).toBe('Chrome');
    expect(context.referrer).toBe('https://ref.example.com/x');
  });

  test('page:false drops ONLY the page keys — device + referrer stay', () => {
    stubNavigator();
    const context = buildContext(LIB, { page: false });
    expect(context).not.toHaveProperty('current_url');
    expect(context).not.toHaveProperty('host');
    expect(context).not.toHaveProperty('pathname');
    expect(context.browser).toBe('Chrome');
    expect(context.referrer).toBe('https://ref.example.com/x');
    expect(context.lib).toBe('analytics-kit-browser');
    expect(typeof context.timezone_offset).toBe('number');
  });

  test('device:false drops ONLY the device keys — page + referrer stay', () => {
    stubNavigator();
    const context = buildContext(LIB, { device: false });
    expect(context).not.toHaveProperty('browser');
    expect(context).not.toHaveProperty('device_type');
    expect(context).not.toHaveProperty('screen_width');
    expect(context).not.toHaveProperty('browser_language');
    expect(context).toHaveProperty('current_url');
    expect(context.referrer).toBe('https://ref.example.com/x');
  });

  test('referrer:false drops ONLY the referrer keys — page + device stay', () => {
    stubNavigator();
    const context = buildContext(LIB, { referrer: false });
    expect(context).not.toHaveProperty('referrer');
    expect(context).not.toHaveProperty('referring_domain');
    expect(context).toHaveProperty('current_url');
    expect(context.browser).toBe('Chrome');
  });

  test('an explicit true is treated the same as absent (opt-out semantics)', () => {
    stubNavigator();
    const context = buildContext(LIB, { page: true, device: true, referrer: true });
    expect(context).toHaveProperty('current_url');
    expect(context.browser).toBe('Chrome');
    expect(context.referrer).toBe('https://ref.example.com/x');
  });
});
