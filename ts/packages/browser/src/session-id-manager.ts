import { generateUuidV7 } from './uuid-v7';
import { SESSION_ID_KEY } from './persistence-keys';
import type { PersistenceStore } from './persistence-store';

// A swappable id-minting strategy, so a consumer or a future adapter can change
// the session-id scheme without touching the expiry semantics. Defaults to the
// crypto UUIDv7 generator; the v7 timestamp prefix is what lets a session-start
// time be read back out of the id.
export type IdGenerator = () => string;

export const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
export const DEFAULT_SESSION_MAX_LENGTH_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface SessionIdManagerOptions {
  store: PersistenceStore;
  idleTimeoutMs?: number;
  maxLengthMs?: number;
  sessionIdGenerator?: IdGenerator;
}

// The [WIRE] persisted session tuple: [lastActivityTimestamp, sessionId,
// sessionStartTimestamp]. Normalized inside the adapter — the neutral surface
// only ever sees the session id string, never this shape or its storage key.
type SessionTuple = [number, string | null, number];

const EMPTY_TUPLE: SessionTuple = [0, null, 0];

// Owns the browser adapter's session id: assigns a UUIDv7 session id that expires
// on idle (default 30 min) OR max length (default 24 h), advancing the idle clock
// from the timestamp of each captured event and minting a fresh id on expiry.
// Stateful — the current id is a function of the event timestamps seen, not a
// plain storage read. Works identically whether the backing store is durable or
// memory-only (the mint is independent of storage backing).
export class SessionIdManager {
  private readonly store: PersistenceStore;
  private readonly idleTimeoutMs: number;
  private readonly maxLengthMs: number;
  private readonly sessionIdGenerator: IdGenerator;

  constructor(options: SessionIdManagerOptions) {
    this.store = options.store;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS;
    this.maxLengthMs = options.maxLengthMs ?? DEFAULT_SESSION_MAX_LENGTH_MS;
    this.sessionIdGenerator = options.sessionIdGenerator ?? generateUuidV7;
  }

  // Returns the current session id, advancing the idle clock from `timestamp` and
  // minting a fresh id when the session is absent, idle too long, or past its max
  // length. This is behavior, not a KV read: the same stored tuple yields a
  // different result depending on the timestamp passed in.
  checkAndGetSessionId(timestamp: number): string {
    const [, currentId, startTimestamp] = this.getTuple();
    const lastActivityTimestamp = this.getLastActivity();

    const noSessionId = currentId === null;
    const idleTooLong =
      !noSessionId && this.hasBeenIdleTooLong(timestamp, lastActivityTimestamp);
    const pastMaximumLength =
      startTimestamp > 0 && Math.abs(timestamp - startTimestamp) > this.maxLengthMs;

    if (noSessionId || idleTooLong || pastMaximumLength) {
      const freshId = this.sessionIdGenerator();
      this.setTuple(freshId, timestamp, timestamp);
      return freshId;
    }

    // Extend the live session: keep the id and start, advance last activity.
    this.setTuple(currentId, timestamp, startTimestamp);
    return currentId;
  }

  // Clears the session so the next checkAndGetSessionId call mints a new id.
  // Adapter-internal — S9's reset() calls this without reaching into internals.
  resetSessionId(): void {
    this.store.unregister(SESSION_ID_KEY);
  }

  private hasBeenIdleTooLong(timestamp: number, lastActivityTimestamp: number): boolean {
    if (timestamp <= 0 || lastActivityTimestamp <= 0) {
      return false;
    }
    return Math.abs(timestamp - lastActivityTimestamp) > this.idleTimeoutMs;
  }

  private getLastActivity(): number {
    return this.getTuple()[0];
  }

  private getTuple(): SessionTuple {
    const stored = this.store.getProperty<SessionTuple>(SESSION_ID_KEY);
    if (Array.isArray(stored) && stored.length === 3) {
      return stored;
    }
    return EMPTY_TUPLE;
  }

  private setTuple(
    sessionId: string,
    lastActivityTimestamp: number,
    startTimestamp: number
  ): void {
    this.store.register({
      [SESSION_ID_KEY]: [lastActivityTimestamp, sessionId, startTimestamp],
    });
  }
}
