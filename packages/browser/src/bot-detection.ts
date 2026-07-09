// User-agent substrings that identify bots and crawlers. Matched case-insensitively
// as substrings of the full UA; the consumer can extend this list via config.
export const DEFAULT_BLOCKED_UA_STRS: readonly string[] = [
  'amazonbot',
  'amazonproductbot',
  'app.hypefactors.com',
  'applebot',
  'archive.org_bot',
  'awariobot',
  'backlinksextendedbot',
  'baiduspider',
  'bingbot',
  'bingpreview',
  'chrome-lighthouse',
  'dataforseobot',
  'deepscan',
  'duckduckbot',
  'facebookexternal',
  'facebookcatalog',
  'http://yandex.com/bots',
  'hubspot',
  'ia_archiver',
  'leikibot',
  'linkedinbot',
  'meta-externalagent',
  'mj12bot',
  'msnbot',
  'nessus',
  'petalbot',
  'pinterest',
  'prerender',
  'rogerbot',
  'screaming frog',
  'sebot-wa',
  'sitebulb',
  'slackbot',
  'slurp',
  'trendictionbot',
  'turnitin',
  'twitterbot',
  'vercel-screenshot',
  'vercelbot',
  'yahoo! slurp',
  'yandexbot',
  'zoombot',

  // Bot-like word fragments
  'bot.htm',
  'bot.php',
  '(bot;',
  'bot/',
  'crawler',

  'ahrefsbot',
  'ahrefssiteaudit',

  'semrushbot',
  'siteauditbot',
  'splitsignalbot',

  // AI crawlers
  'gptbot',
  'oai-searchbot',
  'chatgpt-user',
  'perplexitybot',

  // Uptime monitors
  'better uptime bot',
  'sentryuptimebot',
  'uptimerobot',

  // Headless browsers
  'headlesschrome',
  'cypress',

  // Google-specific crawlers
  'google-hoteladsverifier',
  'adsbot-google',
  'apis-google',
  'duplexweb-google',
  'feedfetcher-google',
  'google favicon',
  'google web preview',
  'google-read-aloud',
  'googlebot',
  'googleother',
  'google-cloudvertexbot',
  'googleweblight',
  'mediapartners-google',
  'storebot-google',
  'google-inspectiontool',
  'bytespider',
];

/** Case-insensitive substring match of a user-agent against the default denylist
 * plus any consumer-supplied extension. Missing UA is never a bot. */
export function isBlockedUA(ua: string | undefined, extraBlockedUserAgents: readonly string[] = []): boolean {
  if (!ua) {
    return false;
  }
  const uaLower = ua.toLowerCase();
  return [...DEFAULT_BLOCKED_UA_STRS, ...extraBlockedUserAgents].some((blocked) =>
    uaLower.includes(blocked.toLowerCase())
  );
}

// Experimental navigator.userAgentData shape; only the brands we inspect are typed.
// Kept defensive for forward/backward compatibility.
interface NavigatorUAData {
  brands?: { brand: string; version: string }[];
}

/** True when the client looks automated: its UA (or userAgentData brands) hits the
 * denylist, or navigator.webdriver is set. A missing navigator is never a bot. */
export function isLikelyBot(
  nav: Navigator | undefined,
  extraBlockedUserAgents: readonly string[] = []
): boolean {
  if (!nav) {
    return false;
  }

  if (isBlockedUA(nav.userAgent, extraBlockedUserAgents)) {
    return true;
  }

  try {
    const uaData = (nav as { userAgentData?: NavigatorUAData }).userAgentData;
    if (uaData?.brands?.some((brandObj) => isBlockedUA(brandObj?.brand, extraBlockedUserAgents))) {
      return true;
    }
  } catch {
    // Experimental API; ignore any access error.
  }

  return !!nav.webdriver;
}
