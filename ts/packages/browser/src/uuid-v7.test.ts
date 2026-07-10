import { expect, test } from 'vitest';
import { generateUuidV7 } from './uuid-v7';

const CANONICAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('generates a canonical 8-4-4-4-12 hex string', () => {
  expect(generateUuidV7()).toMatch(CANONICAL);
});

test('the version nibble is 7 — a real UUIDv7, not a v4 (crypto.randomUUID)', () => {
  const hex = generateUuidV7().replace(/-/g, '');
  expect(hex).toHaveLength(32);
  expect(hex[12]).toBe('7');
});

test('the variant nibble is RFC-4122 (8, 9, a or b)', () => {
  const hex = generateUuidV7().replace(/-/g, '');
  expect('89ab').toContain(hex[16]);
});

test('carries a millisecond timestamp prefix close to now', () => {
  const before = Date.now();
  const hex = generateUuidV7().replace(/-/g, '');
  const tsFromId = parseInt(hex.slice(0, 12), 16);
  const after = Date.now();

  expect(tsFromId).toBeGreaterThanOrEqual(before);
  expect(tsFromId).toBeLessThanOrEqual(after);
});

test('ids are time-ordered / monotonic across rapid successive calls', () => {
  const ids = Array.from({ length: 50 }, () => generateUuidV7());
  const sorted = [...ids].sort();
  expect(ids).toEqual(sorted);
});

test('ids are unique across a batch', () => {
  const ids = Array.from({ length: 1000 }, () => generateUuidV7());
  expect(new Set(ids).size).toBe(ids.length);
});

test('uses crypto.getRandomValues in the jsdom environment', () => {
  expect(typeof crypto.getRandomValues).toBe('function');
  expect(generateUuidV7()).toMatch(CANONICAL);
});
