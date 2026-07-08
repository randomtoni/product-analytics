import { expect, test } from 'vitest';
import { resolveIngestUrl } from './ingest-url';

test('no ingestHost resolves to undefined (an unkeyed / no-delivery client needs no target)', () => {
  expect(resolveIngestUrl({})).toBeUndefined();
  expect(resolveIngestUrl({ ingestPath: '/custom/' })).toBeUndefined();
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
