import { afterEach, describe, expect, it } from 'vitest';
import { createAnalytics as createBrowserAnalytics } from '@analytics-kit/browser';
import { startRecording } from '@analytics-kit/browser/replay';
import type { SessionReplayPort } from 'analytics-kit';
import { fernlyTaxonomy } from './taxonomy';
import {
  FERNLY_REPLAY_MASKING,
  createFakeReplayPort,
  createFernlyReplayClient,
} from './replay-harness';

// E14-S5 — Fernly (TS) session-replay exercise. Proves the shipped replay surface (S1–S4) works
// through the neutral SessionReplayPort BY CONFIG ALONE: config-only enablement + sampling +
// masking (bar B), the 4-verb control surface reached via provider.replay, the getReplayId()
// session-linkage read, a bar-A swap to a mock SessionReplayPort with ZERO consumer change, and
// the disabled/unkeyed no-replay paths. Mirrors flag-exercise.test.ts (the flag bar-A/bar-B
// precedent reached via provider.flags), NOT the capture-SPI swap (bar-a-adapter-swap.test.ts).
//
// The behavior proof rides the REAL browser ReplayRecorder (via @analytics-kit/browser
// createAnalytics with replay enabled by config); the fake port exists only for the bar-A
// swap-equivalence proof. Assertions land on the neutral port verbs, never adapter wire keys or
// rrweb internals. The recorder's rrweb body loads async behind a dynamic import — stop() disposes
// it; the synchronous port reads (isActive/getReplayId) do not wait on it.

describe('Fernly replay — config-only enablement populates provider.replay (bar B)', () => {
  it('a keyed client with sessionReplay.enabled gets a real SessionReplayPort in provider.replay', () => {
    const analytics = createFernlyReplayClient();
    expect(analytics.replay).toBeDefined();
    // The 4-verb neutral control surface is present and callable.
    expect(typeof analytics.replay!.start).toBe('function');
    expect(typeof analytics.replay!.stop).toBe('function');
    expect(typeof analytics.replay!.isActive).toBe('function');
    expect(typeof analytics.replay!.getReplayId).toBe('function');
  });

  it('sampleRate + masking are config, not port methods — enabled purely by config (no library edit)', () => {
    // Sampling and masking are supplied on config.sessionReplay (a plain type carrier the recorder
    // consumes behind the adapter). The consumer never calls a per-recording sampling/masking
    // method — the port stays the 4 control verbs (frozen by FrozenReplayMembers in
    // capability-presence.ts). A sampleRate of 1 keeps every session; the masking policy
    // (maskAllInputs default + selectors) is threaded into the recorder behind the adapter, invisible
    // to the neutral surface. Supplying both purely via config populates the port with no library edit.
    const analytics = createFernlyReplayClient({ sampleRate: 1, masking: FERNLY_REPLAY_MASKING });
    const replay = analytics.replay;
    expect(replay).toBeDefined();
    // The consumer reaches ONLY the 4 neutral control verbs — sampling/masking are config, not port
    // methods. (A `replay.sampleRate` / `replay.setMasking` call site does not typecheck against
    // SessionReplayPort; the type pin freezes the surface. Assert the verbs are the reachable API.)
    const port: SessionReplayPort = replay!;
    expect([
      typeof port.start,
      typeof port.stop,
      typeof port.isActive,
      typeof port.getReplayId,
    ]).toEqual(['function', 'function', 'function', 'function']);
  });

  it('the control surface drives start/stop/isActive through provider.replay', () => {
    const analytics = createFernlyReplayClient();
    const replay = analytics.replay!;

    expect(replay.isActive()).toBe(false);
    replay.start();
    expect(replay.isActive()).toBe(true);
    // Idempotent: a second start while active is a no-op (still active, no throw).
    replay.start();
    expect(replay.isActive()).toBe(true);
    replay.stop();
    expect(replay.isActive()).toBe(false);
  });

  it('an out-of-range sampleRate degrades safely (config-only, never throws at init)', () => {
    // The seam left sampleRate an unvalidated type carrier; the recorder normalizes-to-default
    // behind the adapter (S4). A nonsensical rate must NOT fail createAnalytics — config-only
    // adoption never crashes on a bad number.
    expect(() => createFernlyReplayClient({ sampleRate: 1.7 })).not.toThrow();
    expect(() => createFernlyReplayClient({ sampleRate: -3 })).not.toThrow();
    expect(createFernlyReplayClient({ sampleRate: Number.NaN }).replay).toBeDefined();
  });
});

describe('Fernly replay — getReplayId() is the shared session-linkage id (S3 linkage, consumer seat)', () => {
  it('getReplayId() is undefined before any event, then the stable shared session id after capture', () => {
    const analytics = createFernlyReplayClient();
    const replay = analytics.replay!;
    replay.start();

    // The recorder reads the SHARED SessionIdManager (via the adapter) — it mints NO id of its
    // own. Before any captured event mints/commits a session, the shared id is empty, so
    // getReplayId() is undefined (the proof replay does not fabricate an id).
    expect(replay.getReplayId()).toBeUndefined();

    // A real captured event mints + commits the shared session id in the pipeline. getReplayId()
    // now returns THAT shared id — the same id events carry (the S3 linkage; the byte-equality
    // getReplaySessionId() === stamped.sessionId is pinned at the browser unit level).
    analytics.track('signup_started');
    const linked = replay.getReplayId();
    expect(linked).toBeDefined();
    expect(typeof linked).toBe('string');

    // The id is STABLE across further captures in the same session — one session id spans the
    // recording and the events (the join key), never re-minted per read.
    analytics.track('document_uploaded', { documentId: 'doc-1', sizeBytes: 10 });
    expect(replay.getReplayId()).toBe(linked);
    expect(replay.getReplayId()).toBe(linked); // repeated reads are pure — no session advance

    replay.stop();
  });
});

describe('Fernly replay — bar B negative: disabled / unkeyed configs get no replay (gracefully)', () => {
  it('an unkeyed client leaves provider.replay undefined (NoopAdapter path, no recorder)', () => {
    // Byte-identical adoption shape minus the key: the NoopAdapter has no session id to source, so
    // the replay slot stays undefined — an unconfigured environment reads replay-off with zero
    // crash, the config-only bar-B posture.
    const unkeyed = createBrowserAnalytics({
      taxonomy: fernlyTaxonomy,
      sessionReplay: { enabled: true, sampleRate: 1, masking: FERNLY_REPLAY_MASKING },
    });
    expect(unkeyed.replay).toBeUndefined();
  });

  it('a keyed client with sessionReplay disabled/absent leaves provider.replay undefined', () => {
    const disabled = createBrowserAnalytics({
      key: 'fernly-replay-key',
      ingestHost: 'https://ingest.fernly.example',
      taxonomy: fernlyTaxonomy,
      sessionReplay: { enabled: false },
    });
    expect(disabled.replay).toBeUndefined();

    const absent = createBrowserAnalytics({
      key: 'fernly-replay-key',
      ingestHost: 'https://ingest.fernly.example',
      taxonomy: fernlyTaxonomy,
    });
    expect(absent.replay).toBeUndefined();
  });
});

describe('Fernly replay — bar A: swap to a mock SessionReplayPort, ZERO consumer change', () => {
  // The byte-identical consumer control function — run against the real browser ReplayRecorder AND
  // the mock port with no edit. This is the bar-A hard proof for replay: the same neutral
  // start/stop/isActive/getReplayId calls resolve regardless of which SessionReplayPort backs the
  // slot. A DIFFERENT swap from the capture SPI (bar-a-adapter-swap) and from flags — mirrors the
  // flag precedent (swap a port reached via a provider slot), reached via provider.replay.
  const driveReplay = (replay: SessionReplayPort): { activeMid: boolean; idMid: boolean; activeAfter: boolean } => {
    replay.start();
    const activeMid = replay.isActive();
    const idMid = replay.getReplayId() !== undefined;
    replay.stop();
    return { activeMid, idMid, activeAfter: replay.isActive() };
  };

  it('the same control calls resolve against the real recorder and against the mock port', () => {
    const analytics = createFernlyReplayClient();
    // Seed the shared session so the real recorder's getReplayId() is populated during driveReplay.
    analytics.track('signup_started');
    const realRun = driveReplay(analytics.replay!);
    expect(realRun.activeMid).toBe(true);
    expect(realRun.idMid).toBe(true); // the shared session id is present mid-recording
    expect(realRun.activeAfter).toBe(false);

    const mock = createFakeReplayPort('mock-replay-id');
    const mockRun = driveReplay(mock);
    expect(mockRun.activeMid).toBe(true);
    expect(mockRun.idMid).toBe(true); // the mock exposes its own opaque id while active
    expect(mockRun.activeAfter).toBe(false);

    // Consumer code was byte-identical (driveReplay) across the swap — only the backing port
    // changed. The mock proves SessionReplayPort is a genuine neutral seam, not a
    // browser-adapter-shaped leak: no rrweb, no session-id source, no delivery needed to satisfy it.
  });

  it('the mock port getReplayId() is undefined while inactive and defined while active', () => {
    const mock = createFakeReplayPort('mock-replay-id');
    expect(mock.getReplayId()).toBeUndefined();
    mock.start();
    expect(mock.getReplayId()).toBe('mock-replay-id');
    mock.stop();
    expect(mock.getReplayId()).toBeUndefined();
  });
});

describe('Fernly replay — the replay entrypoint is separately importable by a consumer', () => {
  afterEach(() => {
    // Any live rrweb recording started by importing/using the entry is torn down implicitly per
    // test; startRecording here is invoked directly to prove the subpath is reachable, then stopped.
  });

  it('@analytics-kit/browser/replay exposes startRecording (the separate rrweb entrypoint)', () => {
    // The recorder body lives behind its own subpath export so a non-replay consumer never bundles
    // rrweb. A replay consumer can reach it directly; here we prove the subpath resolves and its
    // recording control (a stop fn) is real — then stop it so no live rrweb recording leaks.
    expect(typeof startRecording).toBe('function');
    const handle = startRecording(FERNLY_REPLAY_MASKING);
    // rrweb returns a handle (stop fn + buffer) under jsdom; guard for an env that can't record.
    if (handle !== undefined) {
      expect(typeof handle.stop).toBe('function');
      expect(Array.isArray(handle.buffer)).toBe(true);
      handle.stop();
    }
  });
});
