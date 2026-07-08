import { hasDocument, hasLocalStorage } from './dom';
import { COOKIE_MIRRORED_KEYS } from './persistence-keys';

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

export const cookieBackend: StorageBackend = {
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
    return parseJson(cookieBackend.get(name));
  },

  set(name, value) {
    if (!hasDocument()) {
      return false;
    }
    try {
      const expiry = new Date();
      expiry.setTime(expiry.getTime() + COOKIE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
      const encoded = encodeURIComponent(JSON.stringify(value));
      document.cookie = `${name}=${encoded}; expires=${expiry.toUTCString()}; SameSite=Lax; path=/`;
      return true;
    } catch {
      return false;
    }
  },

  remove(name) {
    if (!hasDocument()) {
      return;
    }
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax; path=/`;
  },
};

export const localStorageBackend: StorageBackend = {
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
};

// Owns its own map, so a fresh instance starts empty (a real reload is a fresh
// page ⇒ fresh instance) and two clients never cross-contaminate. One instance
// per client must be shared between the property store and any raw pre-store
// read so writes on one are visible to the other.
export function createMemoryBackend(): StorageBackend {
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
  };
}

// localStorage holds the full blob; the cookie half mirrors only the identity/
// session subset (small, cross-subdomain-shareable). On read the two merge with
// localStorage winning on conflict.
export function createLocalStoragePlusCookieBackend(
  cookieMirroredKeys: readonly string[]
): StorageBackend {
  return {
    isSupported: () => localStorageBackend.isSupported(),

    get(name) {
      return localStorageBackend.get(name);
    },

    parse(name) {
      const cookieEntry = cookieBackend.parse(name);
      const localEntry = localStorageBackend.parse(name);
      if (cookieEntry === null && localEntry === null) {
        return null;
      }
      return { ...(cookieEntry ?? {}), ...(localEntry ?? {}) };
    },

    set(name, value) {
      const stored = localStorageBackend.set(name, value);
      const entry = value as StorageEntry;
      const cookieMirror: StorageEntry = {};
      for (const key of cookieMirroredKeys) {
        if (entry[key] !== undefined && entry[key] !== null) {
          cookieMirror[key] = entry[key];
        }
      }
      if (Object.keys(cookieMirror).length > 0) {
        cookieBackend.set(name, cookieMirror);
      }
      return stored;
    },

    remove(name) {
      localStorageBackend.remove(name);
      cookieBackend.remove(name);
    },
  };
}

// Mode → property-store backend, falling back gracefully when a backend is
// unsupported. `memoryBackend` is injected so it can be shared with a pre-store
// raw read (see `createMemoryBackend`).
export function buildPropsBackend(
  mode: PersistenceMode,
  memoryBackend: StorageBackend
): StorageBackend {
  switch (mode) {
    case 'memory':
      return memoryBackend;
    case 'cookie':
      return cookieBackend.isSupported() ? cookieBackend : memoryBackend;
    case 'localStorage+cookie':
    default: {
      const localPlusCookie = createLocalStoragePlusCookieBackend(COOKIE_MIRRORED_KEYS);
      if (localPlusCookie.isSupported()) {
        return localPlusCookie;
      }
      return cookieBackend.isSupported() ? cookieBackend : memoryBackend;
    }
  }
}
