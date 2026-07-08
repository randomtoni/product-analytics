import { generateUuidV7 } from './uuid-v7';
import {
  ANONYMOUS_DISTINCT_ID_KEY,
  ANONYMOUS_IDENTITY_STATE,
  DEVICE_ID_KEY,
  DISTINCT_ID_KEY,
  IDENTIFIED_IDENTITY_STATE,
  IDENTITY_STATE_KEY,
  type IdentityState,
} from './persistence-keys';
import type { PersistenceStore } from './persistence-store';

// A swappable id-minting strategy, so a consumer or a future adapter can change
// the id scheme without touching identity semantics. Defaults to the crypto
// UUIDv7 generator; the [WIRE] key names stay hidden inside this module.
export type IdGenerator = () => string;

export interface IdentityStoreOptions {
  store: PersistenceStore;
  deviceIdGenerator?: IdGenerator;
}

// Owns the browser adapter's identity: mints the anonymous distinct id and a
// separate device id at first load, models the explicit `anonymous | identified`
// state, and serves the distinct id from an in-memory cache (no per-read storage
// hit). The [WIRE] encoding — the two id keys, the state key, and the fact that
// at first load the distinct id is seeded equal to the device id — lives here,
// never on the neutral surface.
export class IdentityStore {
  private readonly store: PersistenceStore;
  private readonly deviceIdGenerator: IdGenerator;
  private distinctId!: string;
  private state!: IdentityState;

  constructor(options: IdentityStoreOptions) {
    this.store = options.store;
    this.deviceIdGenerator = options.deviceIdGenerator ?? generateUuidV7;
    this.bootstrap();
  }

  // Read-first, mint-as-fallback — run once at construction, then cached. A
  // persisted device id is never re-minted; the distinct id is seeded from a
  // single fresh id when nothing is stored yet.
  private bootstrap(): void {
    const persistedDeviceId = this.store.getProperty<string>(DEVICE_ID_KEY);
    const persistedDistinctId = this.store.getProperty<string>(DISTINCT_ID_KEY);

    if (persistedDeviceId === undefined) {
      this.store.registerOnce({ [DEVICE_ID_KEY]: this.deviceIdGenerator() });
    }

    if (persistedDistinctId === undefined) {
      const freshId = generateUuidV7();
      this.store.registerOnce({
        [DISTINCT_ID_KEY]: freshId,
        [IDENTITY_STATE_KEY]: ANONYMOUS_IDENTITY_STATE,
      });
      this.distinctId = freshId;
      this.state = ANONYMOUS_IDENTITY_STATE;
      return;
    }

    this.distinctId = persistedDistinctId;
    this.state = this.store.getProperty<IdentityState>(IDENTITY_STATE_KEY) ?? ANONYMOUS_IDENTITY_STATE;
  }

  getDistinctId(): string {
    return this.distinctId;
  }

  getDeviceId(): string {
    return this.store.getProperty<string>(DEVICE_ID_KEY) as string;
  }

  // Adapter-internal only — E4 exposes no public identity-state getter. Kept for
  // S6's anon→identified merge guard, which reads this to decide whether to merge.
  getIdentityState(): IdentityState {
    return this.state;
  }

  // Bind the anonymous actor to `distinctId` and retain the prior anon id. Snapshot
  // the prior id FIRST, then update the cached + persisted distinct id in lockstep,
  // persist the prior id under ANONYMOUS_DISTINCT_ID_KEY (retain, don't swap — so a
  // later in-flight call keeps the merge linkage), and flip state to identified.
  // Returns the retained prior anon id, which the merge event carries as its [WIRE]
  // link. The caller guards that this runs only from the anonymous state on a real
  // id change, so `distinctId` always differs from the returned prior id.
  merge(distinctId: string): string {
    const priorDistinctId = this.distinctId;
    this.distinctId = distinctId;
    this.store.register({
      [DISTINCT_ID_KEY]: distinctId,
      [ANONYMOUS_DISTINCT_ID_KEY]: priorDistinctId,
      [IDENTITY_STATE_KEY]: IDENTIFIED_IDENTITY_STATE,
    });
    this.state = IDENTIFIED_IDENTITY_STATE;
    return priorDistinctId;
  }
}
