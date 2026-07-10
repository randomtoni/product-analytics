import type { NeutralEvent } from 'analytics-kit';
import { describe, expect, test, vi } from 'vitest';
import { joinHostPath } from './ingest-url';
import { createSendBatch, type NodeFetch } from './send-batch';
import { createFlagClient } from './flags/create-flag-client';
import { DefinitionPoller } from './flags/local';

describe('joinHostPath — the single node host+path normalization', () => {
  test('a clean host + leading-slash path joins with exactly one slash', () => {
    expect(joinHostPath('https://ingest.example', '/batch/')).toBe('https://ingest.example/batch/');
  });

  test('a trailing-slash host is normalized (no double slash)', () => {
    expect(joinHostPath('https://ingest.example/', '/batch/')).toBe('https://ingest.example/batch/');
  });

  test('a multi-trailing-slash host strips ALL trailing slashes', () => {
    expect(joinHostPath('https://ingest.example///', '/batch/')).toBe('https://ingest.example/batch/');
  });

  test('surrounding whitespace on the host is trimmed', () => {
    expect(joinHostPath('  https://ingest.example  ', '/flags/')).toBe('https://ingest.example/flags/');
  });

  test('a path missing its leading slash still joins with exactly one', () => {
    expect(joinHostPath('https://ingest.example', 'proxy/collect')).toBe('https://ingest.example/proxy/collect');
  });

  test('an empty host yields a bare host-less path (no synthesized origin)', () => {
    expect(joinHostPath('', '/batch/')).toBe('/batch/');
  });
});

describe('trailing-slash host normalizes identically across capture, flags, and definitions', () => {
  // The bug this closes: capture used `.replace(/\/$/, '')` (strips one slash, no trim) while flags +
  // definitions used `.trim().replace(/\/+$/, '')`. A trailing-slash host produced inconsistent URLs.
  // Now all three route through joinHostPath, so the SAME origin yields the SAME normalized join.

  const captureUrlFor = async (host: string): Promise<string> => {
    let captured = '';
    const fetchImpl: NodeFetch = vi.fn(async (url) => {
      captured = url;
      return { status: 200 };
    });
    const send = createSendBatch({
      config: { key: 'k', ingestHost: host, ingestPath: '/batch/' },
      fetchImpl,
      wait: async () => {},
    });
    const event: NeutralEvent = {
      event: 'e',
      distinctId: 'd',
      properties: {},
      timestamp: new Date('2026-07-08T00:00:00.000Z'),
      dedupeId: 'dd-1',
    };
    await send([event]);
    return captured;
  };

  const flagUrlFor = async (host: string): Promise<string> => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ featureFlags: {}, featureFlagPayloads: {} }),
    }));
    const client = createFlagClient({ key: 'k', flagEndpoint: host, fetch: fetchSpy as never });
    await client.evaluate({ distinctId: 'u1' });
    return (fetchSpy.mock.calls[0] as unknown as [string])[0];
  };

  const definitionsUrlFor = async (host: string): Promise<string> => {
    let captured = '';
    const fetchSpy = vi.fn(async (url: string) => {
      captured = url;
      return { ok: true, status: 200, json: async () => ({ flags: [] }) };
    });
    const poller = new DefinitionPoller({
      definitionsEndpoint: host,
      definitionsKey: 'k_privileged',
      token: 'k_project',
      pollIntervalMs: 30000,
      fetch: fetchSpy as never,
    });
    await poller.start();
    poller.stop();
    return captured;
  };

  test('capture: a trailing-slash and a double-slash host land on the same /batch/ URL (no //)', async () => {
    const clean = await captureUrlFor('https://ingest.example');
    const trailing = await captureUrlFor('https://ingest.example/');
    const doubled = await captureUrlFor('https://ingest.example//');

    expect(clean).toBe('https://ingest.example/batch/');
    expect(trailing).toBe(clean);
    expect(doubled).toBe(clean);
    expect(clean).not.toContain('.example//');
  });

  test('flags: a trailing-slash and a double-slash host land on the same /flags/ URL (no //)', async () => {
    const clean = await flagUrlFor('https://flags.example');
    const trailing = await flagUrlFor('https://flags.example/');
    const doubled = await flagUrlFor('https://flags.example//');

    expect(clean).toBe('https://flags.example/flags/');
    expect(trailing).toBe(clean);
    expect(doubled).toBe(clean);
    expect(clean).not.toContain('.example//');
  });

  test('definitions: a trailing-slash and a double-slash host land on the same definitions URL (no //)', async () => {
    const clean = await definitionsUrlFor('https://flags.example');
    const trailing = await definitionsUrlFor('https://flags.example/');
    const doubled = await definitionsUrlFor('https://flags.example//');

    // The path portion (before the query string) is the normalized join; the query params follow.
    expect(clean.startsWith('https://flags.example/flags/definitions?')).toBe(true);
    expect(trailing).toBe(clean);
    expect(doubled).toBe(clean);
    expect(clean).not.toContain('.example//');
  });
});
