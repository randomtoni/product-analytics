import { describe, expect, test } from 'vitest';
import { resolveIngestUrl, resolveReplayIngestUrl } from './ingest-url';

test('no ingestHost resolves to undefined (an unkeyed / no-delivery client needs no target)', () => {
  expect(resolveIngestUrl({})).toBeUndefined();
  expect(resolveIngestUrl({ ingestPath: '/custom/' })).toBeUndefined();
});

test('a blank or whitespace-only ingestHost resolves to undefined (no relative-URL target)', () => {
  expect(resolveIngestUrl({ ingestHost: '' })).toBeUndefined();
  expect(resolveIngestUrl({ ingestHost: '   ' })).toBeUndefined();
  expect(resolveIngestUrl({ ingestHost: '  ', ingestPath: '/ingest/' })).toBeUndefined();
});

test('a bare host appends the default wire capture path with a single separator', () => {
  expect(resolveIngestUrl({ ingestHost: 'https://analytics.example.com' })).toBe(
    'https://analytics.example.com/batch/'
  );
});

test('a trailing slash on the host is normalized — no double slash at the join', () => {
  expect(resolveIngestUrl({ ingestHost: 'https://analytics.example.com/' })).toBe(
    'https://analytics.example.com/batch/'
  );
});

test('multiple trailing slashes on the host collapse to a single separator', () => {
  expect(resolveIngestUrl({ ingestHost: 'https://analytics.example.com///' })).toBe(
    'https://analytics.example.com/batch/'
  );
});

test('surrounding whitespace on the host is trimmed before the join', () => {
  expect(resolveIngestUrl({ ingestHost: '  https://analytics.example.com  ' })).toBe(
    'https://analytics.example.com/batch/'
  );
});

test('an ingestPath override replaces the wire path', () => {
  expect(
    resolveIngestUrl({ ingestHost: 'https://analytics.example.com', ingestPath: '/ingest/' })
  ).toBe('https://analytics.example.com/ingest/');
});

test('an ingestPath override missing its leading slash gets one (no missing separator)', () => {
  expect(
    resolveIngestUrl({ ingestHost: 'https://analytics.example.com', ingestPath: 'ingest/' })
  ).toBe('https://analytics.example.com/ingest/');
});

test('host trailing slash + path leading slash together still join with exactly one slash', () => {
  expect(
    resolveIngestUrl({ ingestHost: 'https://analytics.example.com/', ingestPath: '/ingest/' })
  ).toBe('https://analytics.example.com/ingest/');
});

test('a host with a sub-path (reverse proxy mount) keeps that path and appends the wire path', () => {
  expect(resolveIngestUrl({ ingestHost: 'https://example.com/proxy' })).toBe(
    'https://example.com/proxy/batch/'
  );
});

describe('resolveReplayIngestUrl (E14-S4)', () => {
  test('no ingestHost resolves to undefined (a no-delivery client needs no replay target)', () => {
    expect(resolveReplayIngestUrl(undefined)).toBeUndefined();
  });

  test('a blank or whitespace-only host resolves to undefined', () => {
    expect(resolveReplayIngestUrl('')).toBeUndefined();
    expect(resolveReplayIngestUrl('   ')).toBeUndefined();
  });

  test('reuses the SAME host as capture but appends the fixed replay path (not the batch path)', () => {
    expect(resolveReplayIngestUrl('https://analytics.example.com')).toBe(
      'https://analytics.example.com/s/'
    );
    // The host is shared with capture; only the path differs — the delivery PATH stays separate.
    expect(resolveReplayIngestUrl('https://analytics.example.com')).not.toBe(
      resolveIngestUrl({ ingestHost: 'https://analytics.example.com' })
    );
  });

  test('a trailing slash on the host is normalized — no double slash at the join', () => {
    expect(resolveReplayIngestUrl('https://analytics.example.com/')).toBe(
      'https://analytics.example.com/s/'
    );
  });

  test('surrounding whitespace on the host is trimmed before the join', () => {
    expect(resolveReplayIngestUrl('  https://analytics.example.com  ')).toBe(
      'https://analytics.example.com/s/'
    );
  });

  test('a host with a sub-path (reverse proxy mount) keeps it and appends the replay path', () => {
    expect(resolveReplayIngestUrl('https://example.com/proxy')).toBe('https://example.com/proxy/s/');
  });
});
