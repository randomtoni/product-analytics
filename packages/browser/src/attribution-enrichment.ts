import type { NeutralProperties } from 'analytics-kit';

// Campaign / attribution enrichment: the three DISTINCT lifespans of acquisition data,
// as pure derivations from the current URL + referrer. The stateful pieces (which
// session an entry-prop was captured under; whether an initial-prop has been written)
// live in the adapter — this module only derives, it holds no state.
//
// - parseCampaignParams(): per-EVENT — fresh utm/click-id keys from the live URL query.
// - buildEntryInfo() / derivePersonProps(): the raw {referrer, url} an entry-prop / initial-
//   prop is derived from, and the neutral prop bag derived from a stored {referrer, url}.
// - deriveSessionEntryProps(): per-SESSION — the stored entry {referrer, url} re-prefixed.
// - deriveInitialProps(): set-once-per-IDENTITY — the same, re-prefixed `initial_*`.
//
// De-branded from posthog-js `event-utils.ts` (getCampaignParams / getPersonInfo /
// getPersonPropsFromInfo / getInitialPersonPropsFromInfo) + `session-props.ts`
// (getSessionProps). Every key here is NEUTRAL (no `$`-prefix) and library-computed ⇒
// trusted (derived from URL/referrer, never consumer event props — added downstream of
// the E3 facade allowlist, never re-gated). Every environment read is guarded so a
// missing DOM yields ABSENT keys, not a throw.

const DIRECT = 'direct';

// The library-owned neutral re-prefix stems (NOT derived from posthog's `$session_entry_`/
// `$initial_` at the callsite — the prefix scheme is a neutral-surface decision the
// library owns). `current_url` re-prefixes to `session_entry_url` deliberately, matching
// posthog's `$session_entry_url` special-case (session-props.ts:111-113).
const SESSION_ENTRY_PREFIX = 'session_entry_';
const INITIAL_PREFIX = 'initial_';

// A key deriveInitialProps ALWAYS emits (referrer defaults to 'direct', so it survives
// stripEmpty) — the sentinel writeInitialProps checks to skip re-deriving after the first
// registerOnce. Must stay a key derivePersonProps guarantees for the guard to hold.
export const INITIAL_PROPS_SENTINEL_KEY = `${INITIAL_PREFIX}referrer`;

// The campaign parameters parsed from the URL query into neutral keys — utm_* plus the
// common click-ids. De-branded from posthog's CAMPAIGN_PARAMS (event-utils.ts:45-54);
// the names are already vendor-neutral URL query tokens, so they carry through verbatim.
export const CAMPAIGN_PARAMS: readonly string[] = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'gad_source',
  'mc_cid',
  'gclid',
  'gclsrc',
  'dclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'msclkid',
  'twclid',
  'li_fat_id',
  'igshid',
  'ttclid',
  'rdt_cid',
  'epik',
  'qclid',
  'sccid',
  'irclid',
  '_kx',
];

// The raw entry info an entry-prop / initial-prop is derived from — the referrer and the
// full entry url. Mirrors posthog's `{ r, u }` (session-props.ts:29-32); named for role.
export interface EntryInfo {
  referrer: string;
  url: string | undefined;
}

function safeLocationHref(): string | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  return window.location?.href;
}

function safeReferrer(): string | undefined {
  return typeof document === 'undefined' ? undefined : document.referrer;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

// Read one query param off a URL. De-branded from posthog's getQueryParam
// (request-utils.ts:44) — split off the hash, take the first `?`-delimited query, match
// the key, decode. Returns undefined for an absent (or valueless) param, so an absent
// param emits NO key rather than an empty string.
function getQueryParam(url: string, param: string): string | undefined {
  const withoutHash = url.split('#')[0] ?? '';
  const query = withoutHash.split(/\?(.*)/)[1] ?? '';
  for (const part of query.replace(/^\?+/, '').split('&')) {
    const [key, ...rest] = part.split('=');
    if (key !== param || rest.length === 0) {
      continue;
    }
    const raw = rest.join('=');
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      // Malformed encoding — keep the raw value rather than dropping the param.
    }
    return value.replace(/\+/g, ' ');
  }
  return undefined;
}

// Parse the campaign params off a given URL string into neutral keys. Absent params emit
// no key (posthog stores `null`; we OMIT — the neutral surface carries no empty-value
// noise). De-branded from posthog's _getCampaignParamsFromUrl (event-utils.ts:115-125).
function parseCampaignParamsFromUrl(url: string): NeutralProperties {
  const props: NeutralProperties = {};
  for (const key of CAMPAIGN_PARAMS) {
    const value = getQueryParam(url, key);
    if (value !== undefined && value.length > 0) {
      props[key] = value;
    }
  }
  return props;
}

// Per-EVENT: the campaign params on the CURRENT url, fresh each call. Absent when there
// is no location; a URL with no campaign params yields an empty bag (no keys).
export function parseCampaignParams(): NeutralProperties {
  const href = safeLocationHref();
  if (href === undefined) {
    return {};
  }
  return parseCampaignParamsFromUrl(href);
}

// Capture the raw entry info off the CURRENT url + referrer. This is the once-per-session
// (and once-per-identity) snapshot the derived props are computed from — de-branded from
// posthog's getPersonInfo (event-utils.ts:212-227). Referrer falls back to the neutral
// 'direct' default when empty.
export function buildEntryInfo(): EntryInfo {
  return {
    referrer: safeReferrer() || DIRECT,
    url: safeLocationHref(),
  };
}

// Derive the neutral attribution prop bag from a stored {referrer, url}. Referrer +
// referring_domain always; when a url is present, current_url/host/pathname + the campaign
// params parsed from THAT stored url. De-branded from posthog's getPersonPropsFromInfo
// (event-utils.ts:229-254). Empty values are dropped so the caller re-prefixes only real keys.
export function derivePersonProps(info: EntryInfo): NeutralProperties {
  const referrer = info.referrer;
  const referringDomain =
    referrer === DIRECT ? DIRECT : hostOf(referrer) ?? DIRECT;

  const props: NeutralProperties = {
    referrer,
    referring_domain: referringDomain,
  };

  const url = info.url;
  if (url) {
    props.current_url = url;
    const host = hostOf(url);
    if (host !== undefined) {
      props.host = host;
    }
    const pathname = pathnameOf(url);
    if (pathname !== undefined) {
      props.pathname = pathname;
    }
    Object.assign(props, parseCampaignParamsFromUrl(url));
  }

  return stripEmpty(props);
}

function pathnameOf(url: string): string | undefined {
  try {
    return new URL(url).pathname || undefined;
  } catch {
    return undefined;
  }
}

// Keep only non-empty strings + numbers, de-branded from posthog's stripEmptyProperties
// (utils/index.ts:95-103) — so `direct`, real urls, and campaign values survive while an
// undefined/empty derived value is dropped before re-prefixing.
function stripEmpty(props: NeutralProperties): NeutralProperties {
  const out: NeutralProperties = {};
  for (const [key, value] of Object.entries(props)) {
    if ((typeof value === 'string' && value.length > 0) || typeof value === 'number') {
      out[key] = value;
    }
  }
  return out;
}

function reprefix(props: NeutralProperties, prefix: string): NeutralProperties {
  const out: NeutralProperties = {};
  for (const [key, value] of Object.entries(props)) {
    // `current_url` → `..._url` (posthog: `$session_entry_url` special-case). Every
    // other key keeps its stem behind the prefix.
    const stem = key === 'current_url' ? 'url' : key;
    out[`${prefix}${stem}`] = value;
  }
  return out;
}

// Per-SESSION: the stored entry {referrer, url} re-prefixed to `session_entry_*` neutral
// keys. De-branded from posthog's getSessionProps (session-props.ts:106-117).
export function deriveSessionEntryProps(info: EntryInfo): NeutralProperties {
  return reprefix(derivePersonProps(info), SESSION_ENTRY_PREFIX);
}

// Set-once-per-IDENTITY: the entry {referrer, url} re-prefixed to `initial_*` neutral keys,
// for a first-touch registerOnce. De-branded from posthog's getInitialPersonPropsFromInfo
// (event-utils.ts:256-266).
export function deriveInitialProps(info: EntryInfo): NeutralProperties {
  return reprefix(derivePersonProps(info), INITIAL_PREFIX);
}
