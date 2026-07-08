import type { StorageBackend, StorageEntry } from './storage-backends';

export interface PersistenceStoreOptions {
  backend: StorageBackend;
  name: string;
  saveDebounceMs?: number;
}

// A property store over a single storage backend. The in-memory `props` is the
// source of truth for reads and is updated synchronously on every write; the
// backend write is coalesced through a save-debounce and forced out on unload.
export class PersistenceStore {
  private readonly backend: StorageBackend;
  private readonly name: string;
  private readonly saveDebounceMs: number;
  private props: StorageEntry = {};
  private pendingSaveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: PersistenceStoreOptions) {
    this.backend = options.backend;
    this.name = options.name;
    this.saveDebounceMs = options.saveDebounceMs ?? 0;
    this.load();

    if (typeof window !== 'undefined') {
      const flush = (): void => this.flush();
      window.addEventListener('beforeunload', flush);
      window.addEventListener('pagehide', flush);
    }
  }

  private load(): void {
    const entry = this.backend.parse(this.name);
    if (entry) {
      this.props = { ...entry };
    }
  }

  getProperty<T>(key: string): T | undefined {
    return this.props[key] as T | undefined;
  }

  // A shallow snapshot of every stored property. The caller owns the copy, so a
  // downstream mutation (e.g. merging into an event) can't corrupt the store.
  entries(): StorageEntry {
    return { ...this.props };
  }

  // Overwrites: a key already present is replaced with the new value.
  register(props: StorageEntry): boolean {
    let changed = false;
    for (const [key, value] of Object.entries(props)) {
      if (this.props[key] !== value) {
        this.props[key] = value;
        changed = true;
      }
    }
    if (changed) {
      this.save();
    }
    return changed;
  }

  // Keeps the first value: a key already present is left untouched, unless its
  // current value equals `defaultValue` (treated as unset).
  registerOnce(props: StorageEntry, defaultValue?: unknown): boolean {
    let changed = false;
    for (const [key, value] of Object.entries(props)) {
      if (!(key in this.props) || this.props[key] === defaultValue) {
        this.props[key] = value;
        changed = true;
      }
    }
    if (changed) {
      this.save();
    }
    return changed;
  }

  unregister(key: string): void {
    if (key in this.props) {
      delete this.props[key];
      this.save();
    }
  }

  save(): void {
    if (this.saveDebounceMs <= 0) {
      this.writeNow();
      return;
    }
    if (this.pendingSaveTimer !== undefined) {
      return;
    }
    this.pendingSaveTimer = setTimeout(() => {
      this.pendingSaveTimer = undefined;
      this.writeNow();
    }, this.saveDebounceMs);
  }

  // Force any pending debounced write out immediately. A no-op when nothing is
  // pending, so an unload flush can never resurrect an entry `clear()` removed.
  flush(): void {
    if (this.pendingSaveTimer === undefined) {
      return;
    }
    clearTimeout(this.pendingSaveTimer);
    this.pendingSaveTimer = undefined;
    this.writeNow();
  }

  clear(): void {
    if (this.pendingSaveTimer !== undefined) {
      clearTimeout(this.pendingSaveTimer);
      this.pendingSaveTimer = undefined;
    }
    this.backend.remove(this.name);
    this.props = {};
  }

  private writeNow(): void {
    this.backend.set(this.name, this.props);
  }
}
