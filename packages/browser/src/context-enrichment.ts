import type { EnrichmentConfig, NeutralProperties } from 'analytics-kit';
import { detectDeviceType, parseUserAgent, type DeviceTypeSignals, type UserAgentHints } from './user-agent';

// Per-event auto-enrichment: the neutral page / device-browser-OS / referrer / timezone
// / lib context computed FRESH on every event and merged into the property bag as
// defaults (a per-call consumer prop of the same key wins). Every value here is
// library-computed ⇒ trusted — added downstream of the E3 facade allowlist, never
// re-gated. All keys are neutral (no `$`-prefix); the wire-mapper passes them through
// verbatim, so there is no wire-rename step. De-branded from the reference per-capture
// property build; the `$direct` referrer sentinel becomes the internal 'direct' default.
//
// The three source-of-signal groups (page / device / referrer) are split into their
// own self-guarding helpers so E6-S5 can toggle them independently without re-cutting
// this module; timezone + lib are always-on and computed inline. Every environment read
// (location, navigator, screen, window.inner*, document.referrer, Intl) is guarded so a
// missing DOM yields ABSENT keys, not a throw.

const DIRECT = 'direct';

// The adapter's own library identity, passed in so this module stays free of the
// adapter's construction details — the enrichment writes them as the `lib`/`lib_version`
// context keys.
export interface LibraryIdentity {
  libraryId: string;
  libraryVersion: string;
}

interface UserAgentDataLike {
  platform?: string;
  brands?: unknown;
}

interface NavigatorLike {
  userAgent?: string;
  vendor?: string;
  language?: string;
  maxTouchPoints?: number;
  userAgentData?: UserAgentDataLike;
  brave?: unknown;
}

function safeNavigator(): NavigatorLike | undefined {
  return typeof navigator === 'undefined' ? undefined : (navigator as NavigatorLike);
}

function safeWindow(): (Window & typeof globalThis) | undefined {
  return typeof window === 'undefined' ? undefined : window;
}

// Page context — reads `location` only. Absent when there is no location.
function pageContext(): NeutralProperties {
  const win = safeWindow();
  const loc = win?.location;
  if (loc === undefined) {
    return {};
  }
  const props: NeutralProperties = {};
  if (loc.href) props.current_url = loc.href;
  if (loc.host) props.host = loc.host;
  if (loc.pathname) props.pathname = loc.pathname;
  return props;
}

// Referrer context — reads `document.referrer` only. An empty referrer becomes the
// neutral 'direct' default (de-branded from the reference `$direct` sentinel); the
// referring domain is the referrer URL's host, or 'direct' when there is no referrer.
function referrerContext(): NeutralProperties {
  const doc = typeof document === 'undefined' ? undefined : document;
  if (doc === undefined) {
    return {};
  }
  const referrer = doc.referrer || DIRECT;
  return {
    referrer,
    referring_domain: referrer === DIRECT ? DIRECT : hostOf(doc.referrer) ?? DIRECT,
  };
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

// Device / browser / OS context — reads navigator + screen + window.inner*. The UA
// parse (browser/browser_version/os/os_version) is delegated to the pure parser; the
// coarse device_type is computed here because it needs screen signals.
function deviceContext(): NeutralProperties {
  const nav = safeNavigator();
  const win = safeWindow();
  const props: NeutralProperties = {};

  const ua = nav?.userAgent;
  if (ua) {
    const hints: UserAgentHints = nav?.brave ? { brave: true } : {};
    const parsed = parseUserAgent(ua, nav?.vendor, hints);
    if (parsed.browser) props.browser = parsed.browser;
    if (parsed.browserVersion !== null) props.browser_version = parsed.browserVersion;
    if (parsed.os) props.os = parsed.os;
    if (parsed.osVersion) props.os_version = parsed.osVersion;

    const signals: DeviceTypeSignals = {
      userAgentDataPlatform: nav?.userAgentData?.platform,
      maxTouchPoints: nav?.maxTouchPoints,
      screenWidth: win?.screen?.width,
      screenHeight: win?.screen?.height,
      devicePixelRatio: win?.devicePixelRatio,
    };
    props.device_type = detectDeviceType(ua, signals);
  }

  const screen = win?.screen;
  if (screen !== undefined) {
    props.screen_height = screen.height;
    props.screen_width = screen.width;
  }
  if (win !== undefined) {
    props.viewport_height = win.innerHeight;
    props.viewport_width = win.innerWidth;
  }

  const language = nav?.language;
  if (language) props.browser_language = language;

  return props;
}

function timezoneContext(): NeutralProperties {
  const props: NeutralProperties = {};
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) props.timezone = tz;
  } catch {
    // Intl unavailable — timezone is simply absent.
  }
  try {
    props.timezone_offset = new Date().getTimezoneOffset();
  } catch {
    // Absent rather than a throw.
  }
  return props;
}

// Per-module enrichment opt-out (E6-S5). Each group defaults ON (absent ⇒ enriched);
// setting one false disables ONLY that group's spread. A new enrichment module adds its
// own toggle here without re-cutting the others (S6 nests `country`, S8 reads per-context).
export type ContextToggles = Pick<EnrichmentConfig, 'page' | 'device' | 'referrer'>;

// The neutral context bag for one event. Fresh on every call — nothing is cached, so a
// navigation between captures is reflected. Merged into the event by the caller as a
// default (consumer props win). Each of page/device/referrer is gated on its E6-S5 toggle
// (absent ⇒ on); timezone + lib are always-on.
export function buildContext(
  library: LibraryIdentity,
  toggles: ContextToggles = {}
): NeutralProperties {
  return {
    ...(toggles.page !== false ? pageContext() : {}),
    ...(toggles.device !== false ? deviceContext() : {}),
    ...(toggles.referrer !== false ? referrerContext() : {}),
    ...timezoneContext(),
    lib: library.libraryId,
    lib_version: library.libraryVersion,
  };
}
