import { expect, test } from 'vitest';
import { generateUuid } from './uuid';

test('generates a non-empty v4-shaped id using only ES built-ins', () => {
  const id = generateUuid();

  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('produces distinct ids across calls', () => {
  const ids = new Set(Array.from({ length: 1000 }, () => generateUuid()));

  expect(ids.size).toBe(1000);
});
