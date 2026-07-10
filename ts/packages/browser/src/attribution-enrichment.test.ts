import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  buildEntryInfo,
  deriveInitialProps,
  deriveSessionEntryProps,
  derivePersonProps,
  parseCampaignParams,
  type EntryInfo,
} from './attribution-enrichment';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Drive the parse off a controlled URL by stubbing window.location.href.
function stubUrl(href: string): void {
  vi.stubGlobal('window', { location: { href } });
}

describe('parseCampaignParams — per-event, fresh from the live URL', () => {
  test('extracts utm_* + click-id params into neutral keys — NONE $-prefixed', () => {
    stubUrl(
      'https://shop.example.com/landing?utm_source=news&utm_medium=email&utm_campaign=spring&utm_term=shoes&utm_content=cta&gclid=abc123&fbclid=fb456'
    );

    const params = parseCampaignParams();

    expect(params).toEqual({
      utm_source: 'news',
      utm_medium: 'email',
      utm_campaign: 'spring',
      utm_term: 'shoes',
      utm_content: 'cta',
      gclid: 'abc123',
      fbclid: 'fb456',
    });
    for (const key of Object.keys(params)) {
      expect(key.startsWith('$')).toBe(false);
    }
  });

  test('absent params emit NO keys (a URL with no campaign query yields an empty bag)', () => {
    stubUrl('https://shop.example.com/landing?ref=friend&page=2');
    expect(parseCampaignParams()).toEqual({});
  });

  test('a partial set emits only the present keys, not empty placeholders', () => {
    stubUrl('https://shop.example.com/?utm_source=twitter');
    expect(parseCampaignParams()).toEqual({ utm_source: 'twitter' });
  });

  test('decodes url-encoded values and normalizes + to space', () => {
    stubUrl('https://shop.example.com/?utm_campaign=spring%20sale&utm_content=hero+banner');
    const params = parseCampaignParams();
    expect(params.utm_campaign).toBe('spring sale');
    expect(params.utm_content).toBe('hero banner');
  });

  test('ignores the hash fragment when reading query params', () => {
    stubUrl('https://shop.example.com/?utm_source=news#utm_source=fake');
    expect(parseCampaignParams()).toEqual({ utm_source: 'news' });
  });

  test('parses fresh on every call — a URL change between calls is reflected', () => {
    stubUrl('https://shop.example.com/?utm_source=first');
    expect(parseCampaignParams().utm_source).toBe('first');
    stubUrl('https://shop.example.com/?utm_source=second');
    expect(parseCampaignParams().utm_source).toBe('second');
  });

  test('no location (no DOM) yields an empty bag, not a throw', () => {
    const globalObj = globalThis as Record<string, unknown>;
    const savedWindow = globalObj.window;
    try {
      delete globalObj.window;
      expect(parseCampaignParams()).toEqual({});
    } finally {
      globalObj.window = savedWindow;
    }
  });
});

describe('derivePersonProps — the shared neutral derivation from a stored {referrer, url}', () => {
  test('derives referrer + referring_domain + current_url/host/pathname + campaign params', () => {
    const info: EntryInfo = {
      referrer: 'https://google.com/search?q=x',
      url: 'https://shop.example.com/landing?utm_source=news',
    };
    const props = derivePersonProps(info);
    expect(props.referrer).toBe('https://google.com/search?q=x');
    expect(props.referring_domain).toBe('google.com');
    expect(props.current_url).toBe('https://shop.example.com/landing?utm_source=news');
    expect(props.host).toBe('shop.example.com');
    expect(props.pathname).toBe('/landing');
    expect(props.utm_source).toBe('news');
  });

  test('a direct referrer keeps the neutral direct referring_domain', () => {
    const props = derivePersonProps({ referrer: 'direct', url: 'https://shop.example.com/' });
    expect(props.referrer).toBe('direct');
    expect(props.referring_domain).toBe('direct');
  });

  test('a malformed referrer falls back to the direct referring_domain, not a throw', () => {
    const props = derivePersonProps({ referrer: 'not-a-url', url: undefined });
    expect(props.referrer).toBe('not-a-url');
    expect(props.referring_domain).toBe('direct');
  });

  test('an absent url omits url/host/pathname/campaign keys', () => {
    const props = derivePersonProps({ referrer: 'direct', url: undefined });
    expect(props).not.toHaveProperty('current_url');
    expect(props).not.toHaveProperty('host');
    expect(props).not.toHaveProperty('pathname');
  });
});

describe('deriveSessionEntryProps — per-session re-prefix', () => {
  test('re-prefixes every derived key to session_entry_*, with current_url → session_entry_url', () => {
    const info: EntryInfo = {
      referrer: 'https://google.com/',
      url: 'https://shop.example.com/landing?utm_source=news',
    };
    const props = deriveSessionEntryProps(info);
    expect(props.session_entry_referrer).toBe('https://google.com/');
    expect(props.session_entry_referring_domain).toBe('google.com');
    expect(props.session_entry_url).toBe('https://shop.example.com/landing?utm_source=news');
    expect(props.session_entry_host).toBe('shop.example.com');
    expect(props.session_entry_pathname).toBe('/landing');
    expect(props.session_entry_utm_source).toBe('news');
    // No raw current_url key survives — it is renamed to session_entry_url.
    expect(props).not.toHaveProperty('session_entry_current_url');
    for (const key of Object.keys(props)) {
      expect(key.startsWith('$')).toBe(false);
    }
  });
});

describe('deriveInitialProps — set-once re-prefix', () => {
  test('re-prefixes every derived key to initial_*, with current_url → initial_url', () => {
    const info: EntryInfo = {
      referrer: 'https://google.com/',
      url: 'https://shop.example.com/landing?utm_campaign=spring',
    };
    const props = deriveInitialProps(info);
    expect(props.initial_referrer).toBe('https://google.com/');
    expect(props.initial_referring_domain).toBe('google.com');
    expect(props.initial_url).toBe('https://shop.example.com/landing?utm_campaign=spring');
    expect(props.initial_utm_campaign).toBe('spring');
    for (const key of Object.keys(props)) {
      expect(key.startsWith('$')).toBe(false);
    }
  });
});

describe('buildEntryInfo — the raw snapshot from the current DOM', () => {
  test('reads the live href and referrer', () => {
    vi.stubGlobal('window', { location: { href: 'https://shop.example.com/x?utm_source=a' } });
    vi.spyOn(document, 'referrer', 'get').mockReturnValue('https://ref.example.com/');
    const info = buildEntryInfo();
    expect(info.url).toBe('https://shop.example.com/x?utm_source=a');
    expect(info.referrer).toBe('https://ref.example.com/');
  });

  test('an empty referrer becomes the neutral direct default', () => {
    vi.spyOn(document, 'referrer', 'get').mockReturnValue('');
    expect(buildEntryInfo().referrer).toBe('direct');
  });
});
