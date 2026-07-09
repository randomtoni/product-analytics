import { hasDocument, hasLocalStorage } from './dom';
import { COOKIE_MIRRORED_KEYS } from './persistence-keys';
import { resolveCookieDomain } from './cookie-domain';

export type StorageEntry = Record<string, unknown>;

export type PersistenceMode = 'cookie' | 'localStorage+cookie' | 'memory';

export const DEFAULT_PERSISTENCE_MODE: PersistenceMode = 'localStorage+cookie';

// A named single-entry store: `set`/`parse` round-trip one JSON blob under
// `name`. Deliberately usable on its own — a dedicated side-effect-free read of
// a raw entry (e.g. the durable consent decision, S3) can run against a backend
// WITHOUT constructing the property store that gates it.
export interface StorageBackend {
  isSupported(): boolean;
  get(name: string): string | null;
  parse(name: string): StorageEntry | null;
  set(name: string, value: unknown): boolean;
  remove(name: string): void;
}

// A backend that can ENUMERATE its stored keys by prefix — the extra capability the
// multi-tab offline queue needs to scan every tab's namespaced entry. Kept OFF the base
// StorageBackend contract: only the localStorage backend can honestly enumerate (a cookie
// backend cannot), and only the offline queue consumes it, on the localStorage-backed path.
export interface EnumerableBackend {
  listKeysByPrefix(prefix: string): string[];
}

const COOKIE_EXPIRY_DAYS = 365;

function parseJson(raw: string | null): StorageEntry | null {
  if (raw === null) {
    return null;
  }
  try {
    return JSON.parse(raw) as StorageEntry;
  } catch {
    return null;
  }
}

export interface CookieBackendOptions {
  // The bare cross-subdomain domain (no leading dot), config-authoritative else
  // probe-derived. Undefined ⇒ a host-only cookie (no `domain=` attribute).
  domain?: string;
}

// A cookie-backed store. The resolved cross-subdomain `domain` is captured at
// construction (resolve-once, no per-write flag on the shared `set` signature)
// and appended as `; domain=.<d>` to every write and delete — so a cookie is
// removed at the same scope it was set. `createCookieBackend()` with no domain
// yields the plain host-only cookie the consent-read fallback uses.
export function createCookieBackend(options: CookieBackendOptions = {}): StorageBackend {
  const domainAttribute = options.domain ? `; domain=.${options.domain}` : '';

  const backend: StorageBackend = {
    isSupported: () => hasDocument(),

    get(name) {
      if (!hasDocument()) {
        return null;
      }
      const prefix = `${name}=`;
      const parts = document.cookie.split(';').filter((part) => part.length > 0);
      for (let part of parts) {
        while (part.charAt(0) === ' ') {
          part = part.substring(1);
        }
        if (part.indexOf(prefix) === 0) {
          return decodeURIComponent(part.substring(prefix.length));
        }
      }
      return null;
    },

    parse(name) {
      return parseJson(backend.get(name));
    },

    set(name, value) {
      if (!hasDocument()) {
        return false;
      }
      try {
        const expiry = new Date();
        expiry.setTime(expiry.getTime() + COOKIE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
        const encoded = encodeURIComponent(JSON.stringify(value));
        document.cookie = `${name}=${encoded}; expires=${expiry.toUTCString()}; SameSite=Lax; path=/${domainAttribute}`;
        return true;
      } catch {
        return false;
      }
    },

    remove(name) {
      if (!hasDocument()) {
        return;
      }
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax; path=/${domainAttribute}`;
    },
  };

  return backend;
}

// The domain-less cookie backend: the consent-read fallback (a host-only cookie,
// never cross-subdomain) and the existing storage tests use this instance.
export const cookieBackend: StorageBackend = createCookieBackend();

export const localStorageBackend: StorageBackend & EnumerableBackend = {
  isSupported() {
    if (!hasLocalStorage()) {
      return false;
    }
    try {
      const probe = '__storage_probe__';
      localStorageBackend.set(probe, 'probe');
      const ok = localStorageBackend.get(probe) === JSON.stringify('probe');
      localStorageBackend.remove(probe);
      return ok;
    } catch {
      return false;
    }
  },

  get(name) {
    try {
      return hasLocalStorage() ? localStorage.getItem(name) : null;
    } catch {
      return null;
    }
  },

  parse(name) {
    return parseJson(localStorageBackend.get(name));
  },

  set(name, value) {
    try {
      if (!hasLocalStorage()) {
        return false;
      }
      localStorage.setItem(name, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },

  remove(name) {
    try {
      if (hasLocalStorage()) {
        localStorage.removeItem(name);
      }
    } catch {
      // storage removal is best-effort; a failure here is non-fatal
    }
  },

  listKeysByPrefix(prefix) {
    try {
      if (!hasLocalStorage()) {
        return [];
      }
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key !== null && key.startsWith(prefix)) {
          keys.push(key);
        }
      }
      return keys;
    } catch {
      return [];
    }
  },
};

// Owns its own map, so a fresh instance starts empty (a real reload is a fresh
// page ⇒ fresh instance) and two clients never cross-contaminate. One instance
// per client must be shared between the property store and any raw pre-store
// read so writes on one are visible to the other.
export function createMemoryBackend(): StorageBackend & EnumerableBackend {
  const entries = new Map<string, unknown>();
  return {
    isSupported: () => true,
    get(name) {
      return entries.has(name) ? JSON.stringify(entries.get(name)) : null;
    },
    parse(name) {
      return entries.has(name) ? (entries.get(name) as StorageEntry) : null;
    },
    set(name, value) {
      entries.set(name, value);
      return true;
    },
    remove(name) {
      entries.delete(name);
    },
    listKeysByPrefix(prefix) {
      const keys: string[] = [];
      for (const key of entries.keys()) {
        if (key.startsWith(prefix)) {
          keys.push(key);
        }
      }
      return keys;
    },
  };
}

// localStorage holds the full blob; the cookie half mirrors only the identity/
// session subset (small, cross-subdomain-shareable). On read the two merge with
// localStorage winning on conflict. The cookie mirror uses a domain-scoped cookie
// backend so the mirrored identity keys are shared across subdomains at the same
// domain as a pure-cookie store would use — no host-only split-brain.
export function createLocalStoragePlusCookieBackend(
  cookieMirroredKeys: readonly string[],
  cookieOptions: CookieBackendOptions = {}
): StorageBackend {
  const cookie = createCookieBackend(cookieOptions);

  return {
    isSupported: () => localStorageBackend.isSupported(),

    get(name) {
      return localStorageBackend.get(name);
    },

    parse(name) {
      const cookieEntry = cookie.parse(name);
      const localEntry = localStorageBackend.parse(name);
      if (cookieEntry === null && localEntry === null) {
        return null;
      }
      return { ...(cookieEntry ?? {}), ...(localEntry ?? {}) };
    },

    set(name, value) {
      // A null/undefined value carries no entry to mirror: fail soft (skip the cookie
      // mirror rather than index into null) and let localStorage store the raw value.
      if (value == null) {
        return localStorageBackend.set(name, value);
      }
      const stored = localStorageBackend.set(name, value);
      const entry = value as StorageEntry;
      const cookieMirror: StorageEntry = {};
      for (const key of cookieMirroredKeys) {
        if (entry[key] !== undefined && entry[key] !== null) {
          cookieMirror[key] = entry[key];
        }
      }
      if (Object.keys(cookieMirror).length > 0) {
        cookie.set(name, cookieMirror);
      }
      return stored;
    },

    remove(name) {
      localStorageBackend.remove(name);
      cookie.remove(name);
    },
  };
}

// The durable consent decision is read BEFORE the property store and must sit on a
// backend SEPARATE from the one it gates (reading consent through the persistence
// being gated is circular). localStorage is preferred — durable and NON-cookie, so
// storing the opt-out decision itself writes zero cookies (mirrors the reference's
// localStorage default for opt-out). `memory` mode shares the adapter's single
// memory backend so the pre-store read sees the same instance.
export function resolveConsentBackend(
  mode: PersistenceMode,
  memoryBackend: StorageBackend
): StorageBackend {
  if (mode === 'memory') {
    return memoryBackend;
  }
  // No-localStorage fallback: a non-granted client stores its opt-out decision in
  // ONE cookie here — deliberate. That cookie records the consent PREFERENCE, not
  // tracking, so it is a legitimate strictly-necessary preference cookie, distinct
  // from the tracking cookies the (consent-gated) property store suppresses.
  return localStorageBackend.isSupported() ? localStorageBackend : cookieBackend;
}

export interface PropsBackendCookieOptions {
  // Config-authoritative cross-subdomain domain. When set, the probe never runs.
  cookieDomain?: string;
  // Opt into cross-subdomain sharing; when true and `cookieDomain` is unset, the
  // public-suffix probe derives the domain.
  crossSubdomainCookie?: boolean;
}

// Mode → property-store backend, falling back gracefully when a backend is
// unsupported. `memoryBackend` is injected so it can be shared with a pre-store
// raw read (see `createMemoryBackend`).
//
// The cross-subdomain domain is resolved ONCE here (config-authoritative else the
// public-suffix probe) and threaded into every cookie-writing path. Crucially,
// this is called only when consent is granted (the caller collapses a non-granted
// client to `mode: 'memory'`, which takes the probe-free branch below) — so an
// opted-out / pending / DNT client never resolves a domain and the probe writes
// ZERO throwaway cookies.
export function buildPropsBackend(
  mode: PersistenceMode,
  memoryBackend: StorageBackend,
  cookieOptions: PropsBackendCookieOptions = {}
): StorageBackend {
  switch (mode) {
    case 'memory':
      return memoryBackend;
    case 'cookie': {
      if (!cookieBackend.isSupported()) {
        return memoryBackend;
      }
      const domain = resolveCookieDomain({
        configDomain: cookieOptions.cookieDomain,
        crossSubdomain: cookieOptions.crossSubdomainCookie,
      });
      return createCookieBackend({ domain });
    }
    case 'localStorage+cookie':
    default: {
      const domain = resolveCookieDomain({
        configDomain: cookieOptions.cookieDomain,
        crossSubdomain: cookieOptions.crossSubdomainCookie,
      });
      const localPlusCookie = createLocalStoragePlusCookieBackend(COOKIE_MIRRORED_KEYS, { domain });
      if (localPlusCookie.isSupported()) {
        return localPlusCookie;
      }
      return cookieBackend.isSupported() ? createCookieBackend({ domain }) : memoryBackend;
    }
  }
}
