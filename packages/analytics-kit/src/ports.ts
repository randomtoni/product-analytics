// Minimal capability-port sketches, not frozen contracts: the method surface stays
// loose until a real adapter first implements one. Both slots are undefined in release 1.

export interface FeatureFlagPort {
  getFlag(key: string): unknown;
}

export interface SessionReplayPort {
  start(): void;
}
