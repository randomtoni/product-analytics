// NEW WORK — not a port. A persistence sidecar around the in-memory retry queue so
// undelivered ingest batches survive a full page reload and flush on the next load.
// The reference retry queue is an in-memory array only and does not survive a reload;
// this mirrors that queue's undelivered batches to durable storage and rehydrates
// them on construction. It does NOT reimplement retry — the in-memory RetryQueue
// stays the retry engine; this only mirrors its snapshot and reads it back.
//
// The mirror is a whole-snapshot overwrite: on every send outcome the wrapper
// re-persists the current in-memory snapshot, so a delivered (pruned) batch, a
// permanently-rejected batch, and a budget-exhausted batch all drop from durable
// storage for free — whatever the retry queue currently holds IS exactly what
// should survive a reload. Persistence is gated on granted consent, and rides the
// E4 StorageBackend graceful-fallback machinery under its own store name.
//
// MULTI-TAB SAFETY: the durable store is namespaced PER TAB. Each adapter instance owns
// a unique per-tab key (`${scanPrefix}${tabId}`); persist/drop touch ONLY that key, so a
// second tab constructing with an empty retry queue can never overwrite (clobber) a first
// tab's mirrored batches. rehydrate() instead SCANS every tab's key under the shared
// `scanPrefix`, unions their batches, then clears all scanned keys — taking ownership into
// this tab's in-memory retry queue and reaping keys orphaned by crashed/closed tabs.

import type { StorageBackend, EnumerableBackend } from './storage-backends';

// The durable envelope. An OBJECT (not a bare array) so `StorageBackend.parse` —
// which returns a Record, not an array — round-trips it on the typed path, and so a
// later version/metadata field (or an IndexedDB backend) can extend it without a
// format break. Pin this shape in a test.
interface QueueEnvelope<T> {
  batches: ReadonlyArray<ReadonlyArray<T>>;
}

// Cap the number of persisted batches so a permanently-offline client cannot grow
// storage unbounded. Past the cap the OLDEST batches are dropped (retry order is
// preserved, so the newest — most likely still relevant — batches are kept).
export const DEFAULT_MAX_PERSISTED_BATCHES = 100;

export interface OfflineQueueStoreOptions {
  // An enumerable backend: rehydrate() must scan sibling tabs' keys, so the offline queue
  // requires the localStorage-backed EnumerableBackend, not any StorageBackend. A cookie
  // backend cannot enumerate and never backs this store (see browser-adapter).
  backend: StorageBackend & EnumerableBackend;
  // This tab's OWN namespaced key — persist/drop operate only here, so a second tab's
  // empty snapshot removes only its own (empty) key, never another tab's batches.
  name: string;
  // The shared base prefix every tab's key starts with (`name` === `${scanPrefix}${tabId}`).
  // rehydrate() scans all keys under this prefix to union batches across tabs and reap
  // orphaned keys. Defaults to `name` when absent (single-key legacy behavior).
  scanPrefix?: string;
  // Whether persistence is currently permitted. An opted-out client (consent not
  // granted) persists NOTHING and any existing persisted queue is dropped — the
  // E4-S3 / S2 drop-not-flush contract, extended across a reload.
  isPersistenceAllowed: () => boolean;
  maxBatches?: number;
}

export class OfflineQueueStore<T> {
  private readonly backend: StorageBackend & EnumerableBackend;
  private readonly name: string;
  private readonly scanPrefix: string;
  private readonly isPersistenceAllowed: () => boolean;
  private readonly maxBatches: number;

  constructor(options: OfflineQueueStoreOptions) {
    this.backend = options.backend;
    this.name = options.name;
    this.scanPrefix = options.scanPrefix ?? options.name;
    this.isPersistenceAllowed = options.isPersistenceAllowed;
    this.maxBatches = options.maxBatches ?? DEFAULT_MAX_PERSISTED_BATCHES;
  }

  // Mirror the current in-memory snapshot to durable storage. Called after every
  // send outcome so the durable store stays a pure mirror of the undelivered set:
  // a grow (a newly scheduled retry), a prune (a delivered / rejected / exhausted
  // batch), the size cap — all fall out of re-persisting whatever the queue holds.
  // A not-granted client persists nothing and its durable queue is dropped.
  persist(snapshot: ReadonlyArray<ReadonlyArray<T>>): void {
    if (!this.isPersistenceAllowed()) {
      this.drop();
      return;
    }
    if (snapshot.length === 0) {
      // Nothing undelivered — clear the durable entry rather than persist an empty
      // envelope, so a fully-flushed queue leaves storage empty (the 2xx-prune AC).
      this.backend.remove(this.name);
      return;
    }
    const capped = this.capOldest(snapshot);
    const envelope: QueueEnvelope<T> = { batches: capped };
    this.backend.set(this.name, envelope);
  }

  // Read-then-clear across ALL tabs: scan every namespaced key under the shared prefix
  // (this tab's own key plus any left by sibling / crashed / closed tabs), UNION their
  // batches in scan order, then REMOVE every scanned key. This takes ownership of the whole
  // cross-tab undelivered set into the caller (a durable, multi-tab analogue of
  // RetryQueue.drain()) and reaps orphaned keys, so a persistently-failing batch does not
  // rehydrate forever — the normal per-tab mirror re-persists only what is still undelivered
  // after the first send cycle. The union is capped after merge (oldest dropped past the
  // cap). uuid dedupe upstream makes any double-send from a still-live sibling tab harmless.
  // An opted-out client rehydrates nothing and drops every namespaced key. A corrupt /
  // unexpected-shape entry contributes no batch (fails closed).
  rehydrate(): ReadonlyArray<ReadonlyArray<T>> {
    if (!this.isPersistenceAllowed()) {
      this.drop();
      return [];
    }
    const keys = this.backend.listKeysByPrefix(this.scanPrefix);
    const merged: ReadonlyArray<T>[] = [];
    for (const key of keys) {
      const entry = this.backend.parse(key);
      this.backend.remove(key);
      merged.push(...this.readBatches(entry));
    }
    return this.capOldest(merged);
  }

  // Drop the durable queue outright (opt-out): remove EVERY namespaced key under the shared
  // prefix — this tab's and every sibling tab's — so a denial leaves nothing that could
  // rehydrate and re-send after a reload (the E4-S3 drop-not-flush contract, extended across
  // tabs). Scanning here mirrors rehydrate: a consent denial in one tab must reap all tabs'
  // mirrored batches, not only its own.
  drop(): void {
    for (const key of this.backend.listKeysByPrefix(this.scanPrefix)) {
      this.backend.remove(key);
    }
  }

  private capOldest(
    snapshot: ReadonlyArray<ReadonlyArray<T>>
  ): ReadonlyArray<ReadonlyArray<T>> {
    if (snapshot.length <= this.maxBatches) {
      return snapshot;
    }
    return snapshot.slice(snapshot.length - this.maxBatches);
  }

  private readBatches(entry: Record<string, unknown> | null): ReadonlyArray<ReadonlyArray<T>> {
    if (entry === null) {
      return [];
    }
    const batches = entry.batches;
    if (!Array.isArray(batches)) {
      return [];
    }
    // Keep only well-formed inner batches — each is itself an array. A malformed
    // entry (hand-edited, a future/other version's shape) yields no rehydrated batch
    // rather than throwing in the constructor.
    return batches.filter((batch): batch is T[] => Array.isArray(batch));
  }
}
